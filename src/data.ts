import { query } from './db.js';

export interface StoredChatMessage {
  uuid: string;
  sender_user_uuid: string;
  sender_role: string;
  text: string;
  original_language_code: string;
  created_at: string;
}

/** Asegura la sala de chat del evento (misma tabla que usa el backend Vercel). */
async function ensureChatRoom(
  eventUuid: string,
): Promise<{ uuid: string; status: string }> {
  const rows = await query<{ uuid: string; status: string }>(
    `INSERT INTO ext.chat_room (event_uuid) VALUES ($1)
     ON CONFLICT (event_uuid) DO UPDATE SET updated_at = now()
     RETURNING uuid, status`,
    [eventUuid],
  );
  return rows[0];
}

/**
 * El chat de un evento esta abierto mientras el tour esta "en curso" o
 * "abierto" (no finalizado ni pendiente). Se deriva del ESTADO DEL EVENTO, que
 * es la fuente de verdad confiable (el "Terminar tour" lo deja finalizado),
 * asi no dependemos de una maniobra por socket que puede fallar.
 */
export async function eventChatIsOpen(eventUuid: string): Promise<boolean> {
  const rows = await query<{ progress: string }>(
    `SELECT progress::text AS progress FROM public.events WHERE uuid = $1`,
    [eventUuid],
  );
  const progress = rows[0]?.progress;
  return progress === 'open' || progress === 'in_progress';
}

/** Persiste un mensaje de chat. Devuelve null si el chat esta cerrado. */
export async function persistChatMessage(params: {
  eventUuid: string;
  senderUserUuid: string;
  senderRole: string;
  text: string;
  languageCode: string;
}): Promise<StoredChatMessage | null> {
  if (!(await eventChatIsOpen(params.eventUuid))) return null;
  const room = await ensureChatRoom(params.eventUuid);

  const rows = await query<StoredChatMessage>(
    `INSERT INTO ext.chat_message
       (room_uuid, sender_user_uuid, sender_role, original_text, original_language_code)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING uuid, sender_user_uuid, sender_role,
               original_text AS text, original_language_code, created_at`,
    [
      room.uuid,
      params.senderUserUuid,
      params.senderRole,
      params.text,
      params.languageCode,
    ],
  );
  return rows[0];
}

/**
 * Guarda en cache las traducciones de un mensaje (mapa {idioma: texto}),
 * salteando el idioma original. Idempotente (ON CONFLICT DO NOTHING).
 */
export async function storeChatTranslations(
  messageUuid: string,
  map: Record<string, string>,
  originalLang: string,
): Promise<void> {
  const entries = Object.entries(map).filter(([lang]) => lang !== originalLang);
  for (const [lang, txt] of entries) {
    await query(
      `INSERT INTO ext.chat_message_translation
         (message_uuid, language_code, translated_text)
       VALUES ($1, $2, $3)
       ON CONFLICT (message_uuid, language_code) DO NOTHING`,
      [messageUuid, lang, txt],
    );
  }
}

/**
 * Verifica que el usuario pertenezca al evento antes de dejarlo entrar a la
 * sala en vivo. Un guia pertenece si esta en public.event_tour_guides; un
 * turista si tiene un ticket (public.tickets) o un checkin (public.event_checkins)
 * para ese evento. Evita que cualquier usuario autenticado espie el chat o la
 * ubicacion GPS de turistas de tours ajenos.
 */
export async function isEventMember(
  eventUuid: string,
  userUuid: string,
  isGuide: boolean,
): Promise<boolean> {
  if (isGuide) {
    const rows = await query(
      `SELECT 1 FROM public.event_tour_guides
        WHERE event_uuid = $1 AND tour_guide_uuid = $2
        LIMIT 1`,
      [eventUuid, userUuid],
    );
    return rows.length > 0;
  }
  const rows = await query(
    `SELECT 1 FROM public.tickets
       WHERE event_uuid = $1 AND tourist_uuid = $2
     UNION ALL
     SELECT 1 FROM public.event_checkins
       WHERE event_uuid = $1 AND tourist_uuid = $2
     LIMIT 1`,
    [eventUuid, userUuid],
  );
  return rows.length > 0;
}

/** Cierra la sala de chat del evento (al terminar el recorrido). */
export async function closeChatRoom(eventUuid: string): Promise<void> {
  await query(
    `UPDATE ext.chat_room SET status = 'closed', updated_at = now()
     WHERE event_uuid = $1`,
    [eventUuid],
  );
}

/** Reabre la sala de chat del evento (al comenzar el recorrido). */
export async function openChatRoom(eventUuid: string): Promise<void> {
  await query(
    `INSERT INTO ext.chat_room (event_uuid, status) VALUES ($1, 'open')
     ON CONFLICT (event_uuid) DO UPDATE SET status = 'open', updated_at = now()`,
    [eventUuid],
  );
}

/** Estado del chat del evento ('open'/'closed'), derivado del estado del tour. */
export async function getChatRoomStatus(eventUuid: string): Promise<string> {
  return (await eventChatIsOpen(eventUuid)) ? 'open' : 'closed';
}

/** Upsert de la ultima ubicacion del turista en el evento (sin historial). */
export async function upsertTouristLocation(params: {
  eventUuid: string;
  userUuid: string;
  latitude: number;
  longitude: number;
}): Promise<void> {
  await query(
    `INSERT INTO ext.tourist_location (event_uuid, user_uuid, location, updated_at)
     VALUES ($1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326)::geography, now())
     ON CONFLICT (event_uuid, user_uuid) DO UPDATE SET
       location = EXCLUDED.location,
       updated_at = now()`,
    [params.eventUuid, params.userUuid, params.latitude, params.longitude],
  );
}
