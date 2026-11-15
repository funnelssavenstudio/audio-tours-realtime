// Traduccion de mensajes de chat con Google Cloud Translation API (v2 REST).
// La API key va por env (GOOGLE_TRANSLATE_API_KEY), nunca en el codigo.
// Si no hay key, todo degrada a "sin traduccion" (va el texto original).

const KEY = process.env.GOOGLE_TRANSLATE_API_KEY || '';

// Idiomas destino a los que se traduce cada mensaje. Configurable por env.
// Por defecto, los 13 idiomas confirmados por el cliente, INCLUIDO el español
// (es) y el español latino (es-419): hacen falta como destino para que, cuando
// un turista escribe en otro idioma, al guia (o a quien tenga la app en espanol)
// le llegue traducido. El idioma de origen se descarta solo mas abajo.
const TARGETS = (process.env.TRANSLATE_LANGS ||
  'en,es,es-419,pt,it,fr,cs,zh,hi,de,ru,ar,he')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function translateEnabled(): boolean {
  return KEY.length > 0;
}

async function translateOne(
  text: string,
  source: string,
  target: string,
): Promise<string | null> {
  const url =
    `https://translation.googleapis.com/language/translate/v2?key=${KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: text, source, target, format: 'text' }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as any;
  return data?.data?.translations?.[0]?.translatedText ?? null;
}

/**
 * Devuelve un mapa { codigoIdioma: texto } con el original + sus traducciones
 * a los idiomas destino. Si la key no esta configurada, devuelve solo el
 * original (el chat sigue funcionando, sin traducir).
 */
export async function translateMessage(
  text: string,
  sourceLang: string,
): Promise<Record<string, string>> {
  const map: Record<string, string> = { [sourceLang]: text };
  if (!KEY) return map;
  const targets = TARGETS.filter((l) => l && l !== sourceLang);
  await Promise.all(
    targets.map(async (t) => {
      try {
        const tr = await translateOne(text, sourceLang, t);
        if (tr) map[t] = tr;
      } catch {
        // Si falla un idioma, se ignora (el resto igual se envia).
      }
    }),
  );
  return map;
}
