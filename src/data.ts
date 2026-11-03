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

/** Persiste un mensaje de chat. Devuelve null si la sala esta cerrada. */
export async function persistChatMessage(params: {
  eventUuid: string;
  senderUserUuid: string;
  senderRole: string;
  text: string;
  languageCode: string;
}): Promise<StoredChatMessage | null> {
  const room = await ensureChatRoom(params.eventUuid);
  if (room.status === 'closed') return null;

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
