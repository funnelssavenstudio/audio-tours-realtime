import { io } from 'socket.io-client';

// Tokens falsos (solo para DEV_SKIP_AUTH=1: se decodifica el payload sin verificar firma).
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const makeToken = (p) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64(p)}.sig`;

const EVENT = '11111111-1111-1111-1111-111111111111';
const guideToken = makeToken({ user_uuid: '22222222-2222-2222-2222-222222222222', roles: ['tour_guide'] });
const touristToken = makeToken({ user_uuid: '33333333-3333-3333-3333-333333333333', roles: ['tourist'] });

const r = { joined: [], guideChat: [], touristChat: [], guidePush: [], touristPush: [], errors: [] };

const guide = io('http://localhost:3001', { auth: { token: guideToken }});
const tourist = io('http://localhost:3001', { auth: { token: touristToken }});

guide.on('connect', () => guide.emit('join', { event_uuid: EVENT }));
tourist.on('connect', () => tourist.emit('join', { event_uuid: EVENT }));
guide.on('joined', (d) => r.joined.push(`guide=${d.role}`));
tourist.on('joined', (d) => r.joined.push(`tourist=${d.role}`));
guide.on('chat_message', (m) => r.guideChat.push(`${m.text} [${m.sender_role}]`));
tourist.on('chat_message', (m) => r.touristChat.push(`${m.text} [${m.sender_role}]`));
guide.on('play_checkpoint_audio', (d) => r.guidePush.push(d.checkpoint_uuid));
tourist.on('play_checkpoint_audio', (d) => r.touristPush.push(d.checkpoint_uuid));
guide.on('connect_error', (e) => r.errors.push(`guide: ${e.message}`));
tourist.on('connect_error', (e) => r.errors.push(`tourist: ${e.message}`));

// 1) El turista manda un mensaje -> deberian recibirlo guia Y turista
setTimeout(() => tourist.emit('chat_message', { event_uuid: EVENT, text: 'Hola, donde nos juntamos?', language_code: 'es' }), 800);
// 2) El guia dispara push de audio -> solo el turista deberia recibir
setTimeout(() => guide.emit('push_audio', { event_uuid: EVENT, checkpoint_uuid: 'cp-correcto' }), 1400);
// 3) Un turista intenta push de audio -> debe ser IGNORADO (no es guia)
setTimeout(() => tourist.emit('push_audio', { event_uuid: EVENT, checkpoint_uuid: 'cp-NO-DEBERIA' }), 1700);

setTimeout(() => {
  console.log(JSON.stringify(r, null, 2));
  guide.close();
  tourist.close();
  process.exit(0);
}, 2800);
