// Notificaciones push a ANDROID por FCM HTTP v1 (igual que backend-nuevo/lib/fcm.ts).
// Firma un JWT RS256 con la service account, lo cambia por un access token OAuth2
// y hace POST a fcm.googleapis.com. Nativo + fetch global (Node 18+), sin deps.
// Credenciales por env: FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY.
// Si falta alguna, fcmEnabled() = false y mandar a Android es un no-op.
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';

const PROJECT_ID = process.env.FCM_PROJECT_ID || '';
const CLIENT_EMAIL = process.env.FCM_CLIENT_EMAIL || '';
const PRIVATE_KEY = (process.env.FCM_PRIVATE_KEY || '').replace(/\\n/g, '\n');

export function fcmEnabled(): boolean {
  return Boolean(PROJECT_ID && CLIENT_EMAIL && PRIVATE_KEY);
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

let cachedToken = '';
let cachedExp = 0;
async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < cachedExp - 300) return cachedToken;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: CLIENT_EMAIL,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const key = createPrivateKey(PRIVATE_KEY);
  const sig = cryptoSign('RSA-SHA256', Buffer.from(signingInput), key);
  const jwt = `${signingInput}.${b64url(sig)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!res.ok || !json.access_token) {
    throw new Error(`FCM token error: ${res.status} ${JSON.stringify(json)}`);
  }
  cachedToken = json.access_token;
  cachedExp = now + (json.expires_in ?? 3600);
  return cachedToken;
}

export interface FcmPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface FcmResult {
  token: string;
  status: number;
  gone: boolean;
  reason?: string;
}

export async function sendFcmToToken(
  token: string,
  payload: FcmPayload,
): Promise<FcmResult> {
  let at: string;
  try {
    at = await accessToken();
  } catch (e) {
    return { token, status: 0, gone: false, reason: (e as Error).message };
  }
  try {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: payload.title, body: payload.body },
            data: payload.data ?? {},
            android: { priority: 'HIGH', notification: { sound: 'default' } },
          },
        }),
      },
    );
    if (res.ok) return { token, status: res.status, gone: false };
    let reason: string | undefined;
    try {
      const j = (await res.json()) as {
        error?: { status?: string; message?: string };
      };
      reason = j.error?.status ?? j.error?.message;
    } catch {
      /* sin cuerpo util */
    }
    const gone =
      res.status === 404 ||
      reason === 'UNREGISTERED' ||
      reason === 'INVALID_ARGUMENT';
    return { token, status: res.status, gone, reason };
  } catch (e) {
    return { token, status: 0, gone: false, reason: (e as Error).message };
  }
}
