import { createServer } from 'node:http';
import { Server } from 'socket.io';

import { hasRole, validateSocketToken, type SocketUser } from './auth.js';
import {
  closeChatRoom,
  deleteChatMessage,
  editChatMessage,
  getChatRoomStatus,
  isEventMember,
  openChatRoom,
  persistChatMessage,
  storeChatTranslations,
  upsertTouristLocation,
} from './data.js';
import { translateMessage } from './translate.js';
import { getEventGuideUuids, getEventMemberUuids, sendPushToUsers } from './push.js';
import { monitorMessage } from './alerts.js';

/** Push del chat a los miembros del evento, menos el emisor (best-effort). */
async function notifyChatMessage(
  eventUuid: string,
  senderUuid: string,
  text: string,
): Promise<void> {
  try {
    const members = await getEventMemberUuids(eventUuid);
    const targets = members.filter((u) => u !== senderUuid);
    if (targets.length === 0) return;
    const body = text.length > 140 ? text.slice(0, 137) + '...' : text;
    // Separamos guías de turistas para que, al TOCAR la notif, el chat abra en
    // el modo correcto (el guía con sus controles). is_guide va como string
    // porque los datos de la push deben ser strings.
    const guides = new Set(await getEventGuideUuids(eventUuid));
    const guideTargets = targets.filter((u) => guides.has(u));
    const touristTargets = targets.filter((u) => !guides.has(u));
    const title = 'Nuevo mensaje en el chat';
    if (guideTargets.length > 0) {
      await sendPushToUsers(guideTargets, {
        title,
        body,
        data: { type: 'chat', event_uuid: eventUuid, is_guide: '1' },
      });
    }
    if (touristTargets.length > 0) {
      await sendPushToUsers(touristTargets, {
        title,
        body,
        data: { type: 'chat', event_uuid: eventUuid },
      });
    }
  } catch (e) {
    console.error('[notifyChatMessage] error:', e);
  }
}

const PORT = Number(process.env.PORT ?? 3001);

// Servidor HTTP minimo (health check para DigitalOcean) + socket.io encima.
const httpServer = createServer((req, res) => {
  // '/' y '/health' responden OK (health check de DigitalOcean).
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'OK',
        service: 'audio-tours-realtime',
        time: new Date().toISOString(),
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

const io = new Server(httpServer, { cors: { origin: '*' } });

// Autenticacion en el handshake: el JWT del Rust viaja en auth.token.
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  const user = await validateSocketToken(token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  next();
});

const room = (eventUuid: string) => `event:${eventUuid}`;
const guidesRoom = (eventUuid: string) => `event:${eventUuid}:guides`;
const touristsRoom = (eventUuid: string) => `event:${eventUuid}:tourists`;

io.on('connection', (socket) => {
  const user = socket.data.user as SocketUser;
  const isGuide = hasRole(user, 'tour_guide');

  // Unirse a la sala del evento. Los guias entran ademas a la subsala de guias
  // (para recibir ubicaciones) y los turistas a la de turistas (para el push).
  socket.on('join', async (payload: { event_uuid?: string }) => {
    const eventUuid = payload?.event_uuid;
    if (!eventUuid) return;
    // Solo puede entrar quien pertenece al evento (guia asignado o turista con
    // ticket/checkin). Asi nadie espia el chat ni la ubicacion de tours ajenos.
    let allowed = false;
    try {
      allowed = await isEventMember(eventUuid, user.uuid, isGuide);
    } catch (e) {
      console.error('[join] error verificando pertenencia:', e);
    }
    if (!allowed) {
      socket.emit('join_error', { event_uuid: eventUuid, reason: 'not_member' });
      return;
    }
    await socket.join(room(eventUuid));
    await socket.join(isGuide ? guidesRoom(eventUuid) : touristsRoom(eventUuid));
    // Avisa si la sala de chat esta cerrada, asi el cliente deshabilita el envio
    // desde el arranque (y no deja escribir mensajes que se perderian).
    let chatClosed = false;
    try {
      chatClosed = (await getChatRoomStatus(eventUuid)) === 'closed';
    } catch (e) {
      console.error('[join] error leyendo estado de sala:', e);
    }
    socket.emit('joined', {
      event_uuid: eventUuid,
      role: isGuide ? 'tour_guide' : 'tourist',
      chat_closed: chatClosed,
    });
  });

  // Chat grupal: persiste el mensaje y lo reemite a toda la sala. La traduccion
  // por idioma de cada receptor se suma cuando se enchufe el servicio de
  // traduccion (hoy va el texto original).
  socket.on(
    'chat_message',
    async (payload: { event_uuid?: string; text?: string; language_code?: string }) => {
      const eventUuid = payload?.event_uuid;
      const text = payload?.text?.trim();
      if (!eventUuid || !text) return;
      // Solo si se unio a la sala (paso el gate de pertenencia en 'join').
      if (!socket.rooms.has(room(eventUuid))) return;
      try {
        const msg = await persistChatMessage({
          eventUuid,
          senderUserUuid: user.uuid,
          senderRole: isGuide ? 'tour_guide' : 'tourist',
          text,
          languageCode: payload.language_code ?? 'es',
        });
        if (!msg) {
          socket.emit('chat_error', { reason: 'room_closed' });
          return;
        }
        // Traduce el mensaje a los idiomas destino, cachea y lo emite con el
        // mapa { idioma: texto } para que cada turista lo vea en su idioma.
        let translations: Record<string, string> = {
          [msg.original_language_code]: msg.text,
        };
        try {
          translations = await translateMessage(
            msg.text,
            msg.original_language_code,
          );
          await storeChatTranslations(
            msg.uuid,
            translations,
            msg.original_language_code,
          );
        } catch (err) {
          console.error('[chat_message] translate error:', err);
        }
        io.to(room(eventUuid)).emit('chat_message', {
          ...msg,
          event_uuid: eventUuid,
          translations,
        });
        // Notificacion push a los que no esten mirando el chat (app cerrada).
        void notifyChatMessage(eventUuid, user.uuid, msg.text);
        // Alertas con IA (SEM08): solo mensajes de TURISTAS. Clasifica y, si es
        // queja/perdido, guarda la alerta + push al guia + aviso en vivo al panel.
        if (!isGuide) {
          void monitorMessage({
            eventUuid,
            messageUuid: msg.uuid,
            senderUserUuid: user.uuid,
            text: msg.text,
          }).then((alert) => {
            if (alert) {
              io.to(guidesRoom(eventUuid)).emit('ai_alert', {
                event_uuid: eventUuid,
                ...alert,
                created_at: new Date().toISOString(),
              });
            }
          });
        }
      } catch (e) {
        console.error('[chat_message] error:', e);
        socket.emit('chat_error', { reason: 'server_error' });
      }
    },
  );

  // Editar un mensaje (solo el autor). Re-traduce y avisa a toda la sala con
  // 'chat_message_edited' para que todos actualicen el texto en su idioma.
  socket.on(
    'edit_message',
    async (payload: {
      event_uuid?: string;
      message_uuid?: string;
      text?: string;
      language_code?: string;
    }) => {
      const eventUuid = payload?.event_uuid;
      const messageUuid = payload?.message_uuid;
      const text = payload?.text;
      if (
        !eventUuid ||
        !messageUuid ||
        typeof text !== 'string' ||
        text.trim().length === 0
      )
        return;
      if (!socket.rooms.has(room(eventUuid))) return;
      try {
        const msg = await editChatMessage({
          messageUuid,
          senderUserUuid: user.uuid,
          text: text.trim(),
          languageCode: payload.language_code ?? 'es',
        });
        if (!msg) return; // no es el autor o ya estaba borrado
        let translations: Record<string, string> = {
          [msg.original_language_code]: msg.text,
        };
        try {
          translations = await translateMessage(
            msg.text,
            msg.original_language_code,
          );
          await storeChatTranslations(
            msg.uuid,
            translations,
            msg.original_language_code,
          );
        } catch (err) {
          console.error('[edit_message] translate error:', err);
        }
        io.to(room(eventUuid)).emit('chat_message_edited', {
          ...msg,
          event_uuid: eventUuid,
          translations,
          edited: true,
        });
      } catch (e) {
        console.error('[edit_message] error:', e);
      }
    },
  );

  // Borrar un mensaje (el autor, o un guia/admin). Avisa a toda la sala con
  // 'chat_message_deleted' para que todos lo marquen como eliminado.
  socket.on(
    'delete_message',
    async (payload: { event_uuid?: string; message_uuid?: string }) => {
      const eventUuid = payload?.event_uuid;
      const messageUuid = payload?.message_uuid;
      if (!eventUuid || !messageUuid) return;
      if (!socket.rooms.has(room(eventUuid))) return;
      const canModerate = isGuide || hasRole(user, 'administrator');
      try {
        const ok = await deleteChatMessage({
          messageUuid,
          userUuid: user.uuid,
          canModerate,
        });
        if (!ok) return;
        io.to(room(eventUuid)).emit('chat_message_deleted', {
          event_uuid: eventUuid,
          uuid: messageUuid,
        });
      } catch (e) {
        console.error('[delete_message] error:', e);
      }
    },
  );

  // Ubicacion del turista en vivo: upsert y se manda SOLO a los guias de la sala
  // (no se expone entre turistas).
  socket.on(
    'location_update',
    async (payload: {
      event_uuid?: string;
      latitude?: number;
      longitude?: number;
      checkpoint_index?: number;
      checkpoint_total?: number;
    }) => {
      const eventUuid = payload?.event_uuid;
      const { latitude, longitude } = payload ?? {};
      if (!eventUuid || typeof latitude !== 'number' || typeof longitude !== 'number') return;
      // Solo si se unio a la sala (paso el gate de pertenencia en 'join').
      if (!socket.rooms.has(room(eventUuid))) return;
      // Progreso del turista (punto actual / total), si la app lo mando.
      const checkpointIndex =
        typeof payload?.checkpoint_index === 'number' ? payload.checkpoint_index : undefined;
      const checkpointTotal =
        typeof payload?.checkpoint_total === 'number' ? payload.checkpoint_total : undefined;
      try {
        await upsertTouristLocation({ eventUuid, userUuid: user.uuid, latitude, longitude });
        io.to(guidesRoom(eventUuid)).emit('tourist_location', {
          event_uuid: eventUuid,
          user_uuid: user.uuid,
          name: user.name,
          // UUID de la foto de perfil (el guia la baja del Rust con su token).
          photo_uuid: user.avatar,
          checkpoint_index: checkpointIndex,
          checkpoint_total: checkpointTotal,
          latitude,
          longitude,
          updated_at: new Date().toISOString(),
        });
      } catch {
        /* ignore */
      }
    },
  );

  // Push de audio del guia: reemite a los turistas de la sala para que
  // reproduzcan el audio del checkpoint (ya cargado/offline) en su idioma.
  socket.on('push_audio', (payload: { event_uuid?: string; checkpoint_uuid?: string }) => {
    if (!isGuide) return;
    const eventUuid = payload?.event_uuid;
    const checkpointUuid = payload?.checkpoint_uuid;
    if (!eventUuid || !checkpointUuid) return;
    // Solo el guia que se unio a este evento (paso el gate en 'join').
    if (!socket.rooms.has(room(eventUuid))) return;
    io.to(touristsRoom(eventUuid)).emit('play_checkpoint_audio', {
      event_uuid: eventUuid,
      checkpoint_uuid: checkpointUuid,
    });
  });

  // Aviso del punto de encuentro: el guia manda una ubicacion (y una nota
  // opcional) a los turistas del evento.
  socket.on(
    'meeting_point',
    (payload: {
      event_uuid?: string;
      latitude?: number;
      longitude?: number;
      note?: string;
    }) => {
      if (!isGuide) return;
      const eventUuid = payload?.event_uuid;
      const { latitude, longitude } = payload ?? {};
      if (!eventUuid || typeof latitude !== 'number' || typeof longitude !== 'number') return;
      if (!socket.rooms.has(room(eventUuid))) return;
      io.to(touristsRoom(eventUuid)).emit('meeting_point', {
        event_uuid: eventUuid,
        latitude,
        longitude,
        note: typeof payload.note === 'string' ? payload.note.slice(0, 500) : undefined,
        at: new Date().toISOString(),
      });
    },
  );

  // Cerrar el chat al terminar el recorrido: el guia cierra la sala; no se
  // aceptan mas mensajes (persistChatMessage devuelve null) y se avisa a todos.
  socket.on('close_room', async (payload: { event_uuid?: string }) => {
    if (!isGuide) return;
    const eventUuid = payload?.event_uuid;
    if (!eventUuid) return;
    if (!socket.rooms.has(room(eventUuid))) return;
    try {
      await closeChatRoom(eventUuid);
      io.to(room(eventUuid)).emit('room_closed', { event_uuid: eventUuid });
    } catch (e) {
      console.error('[close_room] error:', e);
    }
  });

  // Reabrir el chat al comenzar el recorrido: el guia reabre la sala y se avisa
  // a todos para que vuelvan a habilitar el envio.
  socket.on('open_room', async (payload: { event_uuid?: string }) => {
    if (!isGuide) return;
    const eventUuid = payload?.event_uuid;
    if (!eventUuid) return;
    if (!socket.rooms.has(room(eventUuid))) return;
    try {
      await openChatRoom(eventUuid);
      io.to(room(eventUuid)).emit('room_opened', { event_uuid: eventUuid });
    } catch (e) {
      console.error('[open_room] error:', e);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`[realtime] escuchando en :${PORT}`);
});
