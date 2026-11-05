import { createServer } from 'node:http';
import { Server } from 'socket.io';

import { hasRole, validateSocketToken, type SocketUser } from './auth.js';
import {
  closeChatRoom,
  getChatRoomStatus,
  isEventMember,
  openChatRoom,
  persistChatMessage,
  upsertTouristLocation,
} from './data.js';

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
        io.to(room(eventUuid)).emit('chat_message', { ...msg, event_uuid: eventUuid });
      } catch (e) {
        console.error('[chat_message] error:', e);
        socket.emit('chat_error', { reason: 'server_error' });
      }
    },
  );

  // Ubicacion del turista en vivo: upsert y se manda SOLO a los guias de la sala
  // (no se expone entre turistas).
  socket.on(
    'location_update',
    async (payload: { event_uuid?: string; latitude?: number; longitude?: number }) => {
      const eventUuid = payload?.event_uuid;
      const { latitude, longitude } = payload ?? {};
      if (!eventUuid || typeof latitude !== 'number' || typeof longitude !== 'number') return;
      // Solo si se unio a la sala (paso el gate de pertenencia en 'join').
      if (!socket.rooms.has(room(eventUuid))) return;
      try {
        await upsertTouristLocation({ eventUuid, userUuid: user.uuid, latitude, longitude });
        io.to(guidesRoom(eventUuid)).emit('tourist_location', {
          event_uuid: eventUuid,
          user_uuid: user.uuid,
          name: user.name,
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
