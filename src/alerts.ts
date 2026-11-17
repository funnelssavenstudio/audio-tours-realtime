// Alertas con IA sobre el chat (SEM08).
// Lee cada mensaje de TURISTA y detecta si es una QUEJA o si el turista esta
// PERDIDO/separado. Si detecta algo, guarda la alerta en ext.chat_alert y le
// manda un push al guia del evento.
//
// Dos niveles:
//  - BASE (gratis, por defecto): deteccion por palabras/frases clave. Sin costo
//    ni cuenta de nadie. Es lo que corre si NO hay ANTHROPIC_API_KEY.
//  - IA (opcional): si hay ANTHROPIC_API_KEY, usa Claude Haiku para una
//    deteccion mas fina (entiende frases sin esas palabras, menos falsos
//    positivos). Cae a la base si la IA falla.
// Kill-switch: ALERTS_DISABLED=1 apaga todo.
import { query } from './db.js';
import { sendPushToUser } from './push.js';

const AI_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.ALERTS_MODEL || 'claude-haiku-5-5';
const DISABLED = process.env.ALERTS_DISABLED === '1';

type AlertType = 'queja' | 'perdido' | 'none';
interface Classification {
  type: AlertType;
  severity: 'low' | 'med' | 'high';
  summary: string;
}

// --- normalizacion: minusculas sin acentos, para matchear sin depender de tildes
function norm(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}
function snippet(s: string): string {
  const t = (s || '').trim().replace(/\s+/g, ' ');
  return t.length > 90 ? t.slice(0, 87) + '...' : t;
}

// Frases/palabras que sugieren un turista PERDIDO o una EMERGENCIA (prioridad alta).
const PERDIDO: RegExp[] = [
  /\bme perd[ií]\b/, /\bperd[ií] al grupo\b/, /\bestoy perdid/, /\bnos perdimos\b/,
  /\bno (los )?encuentro\b/, /\bno veo (al|el) (grupo|guia|bus|micro|colectivo)\b/,
  /\bno veo a nadie\b/, /\bdonde est[aá]n?\b/, /\bdonde (es|esta) el (bus|grupo|punto)\b/,
  /\bme qued[eé]\b/, /\bme separ[eé]\b/, /\bme deja(ron|ste)\b/, /\bestoy sol[oa]\b/,
  /\bayuda\b/, /\bauxilio\b/, /\bsocorro\b/, /\bemergencia\b/, /\bno s[eé] donde\b/,
  /\bme desorient/, /\bel bus se fue\b/, /\bse fueron sin mi\b/,
];
// Frases/palabras que sugieren una QUEJA (prioridad media).
const QUEJA: RegExp[] = [
  /\bno se escucha\b/, /\bno (funciona|anda|carga|sirve|reproduce)\b/, /\bno anda el audio\b/,
  /\bp[eé]sim/, /\bmal[ií]sim/, /\bhorrible\b/, /\bqueja\b/, /\breclam/, /\bproblema\b/,
  /\best[aá] roto\b/, /\bno me gusta\b/, /\bdecepcion/, /\bestafa\b/, /\bverguenza\b/,
  /\bmuy (lento|malo|mala)\b/, /\bse cuelga\b/, /\bse traba\b/, /\bno entiendo nada\b/,
  /\bhace (mucho )?frio\b/, /\best[aá] sucio\b/, /\bmuy caro\b/, /\bno vale la pena\b/,
];

function keywordClassify(text: string): Classification {
  const t = norm(text);
  for (const re of PERDIDO) if (re.test(t)) return { type: 'perdido', severity: 'high', summary: snippet(text) };
  for (const re of QUEJA) if (re.test(t)) return { type: 'queja', severity: 'med', summary: snippet(text) };
  return { type: 'none', severity: 'low', summary: '' };
}

// --- modo IA (opcional) ---
const SYSTEM = `Monitoreas el chat de un tour grupal guiado en Nueva York. Analiza el ULTIMO mensaje de un turista y clasificalo.
Responde SOLO un JSON valido, sin texto extra:
{"type":"queja|perdido|none","severity":"low|med|high","summary":"<=12 palabras, en espanol>"}
Criterios:
- "queja": el turista se queja, esta molesto o insatisfecho, o reporta un problema del servicio (audio, bus, guia, demora, etc.).
- "perdido": el turista esta perdido, separado del grupo, no encuentra al guia o al bus, pide ayuda urgente, o es una emergencia.
- "none": todo normal (saludos, preguntas comunes, charla, agradecimientos).
El "summary" describe el caso para el guia (ej: "No encuentra al grupo en Times Square").`;

async function aiClassify(text: string): Promise<Classification | null> {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': AI_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 120,
        system: SYSTEM,
        messages: [{ role: 'user', content: text.slice(0, 1000) }],
      }),
    });
    if (!r.ok) {
      console.error('[alerts] ai status', r.status);
      return null;
    }
    const j = (await r.json()) as { content?: { text?: string }[] };
    const raw = j?.content?.[0]?.text ?? '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const c = JSON.parse(m[0]) as Classification;
    if (!c || !['queja', 'perdido', 'none'].includes(c.type)) return null;
    if (!['low', 'med', 'high'].includes(c.severity)) c.severity = 'med';
    c.summary = (c.summary || '').toString().slice(0, 200);
    return c;
  } catch (e) {
    console.error('[alerts] ai error', e);
    return null;
  }
}

async function classify(text: string): Promise<Classification> {
  if (AI_KEY) {
    const r = await aiClassify(text);
    if (r) return r; // cae a palabras clave si la IA falla
  }
  return keywordClassify(text);
}

export interface AlertResult {
  uuid: string;
  type: AlertType;
  severity: string;
  summary: string;
}

/**
 * Clasifica un mensaje de turista; si es queja/perdido, guarda la alerta y le
 * manda push al/los guia(s) del evento. Devuelve la alerta (para emitirla por
 * socket al panel) o null si no hay nada que alertar.
 */
export async function monitorMessage(opts: {
  eventUuid: string;
  roomUuid?: string | null;
  messageUuid: string;
  senderUserUuid: string;
  text: string;
}): Promise<AlertResult | null> {
  if (DISABLED) return null;
  const c = await classify(opts.text);
  if (c.type === 'none') return null;

  let uuid: string;
  try {
    const rows = await query<{ uuid: string }>(
      `INSERT INTO ext.chat_alert
         (event_uuid, room_uuid, message_uuid, sender_user_uuid, type, severity, summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING uuid`,
      [
        opts.eventUuid,
        opts.roomUuid ?? null,
        opts.messageUuid,
        opts.senderUserUuid,
        c.type,
        c.severity,
        c.summary,
      ],
    );
    uuid = rows[0].uuid;
  } catch (e) {
    console.error('[alerts] insert error', e);
    return null;
  }

  // Push al/los guia(s) del evento.
  try {
    const guides = await query<{ uuid: string }>(
      `SELECT tour_guide_uuid AS uuid FROM public.event_tour_guides WHERE event_uuid = $1`,
      [opts.eventUuid],
    );
    const title =
      c.type === 'perdido' ? 'Posible turista perdido' : 'Posible queja en el chat';
    for (const g of guides) {
      if (!g.uuid) continue;
      void sendPushToUser(g.uuid, {
        title,
        body: c.summary,
        data: { kind: 'ai_alert', event_uuid: opts.eventUuid, alert_type: c.type },
      });
    }
  } catch (e) {
    console.error('[alerts] push error', e);
  }

  return { uuid, type: c.type, severity: c.severity, summary: c.summary };
}
