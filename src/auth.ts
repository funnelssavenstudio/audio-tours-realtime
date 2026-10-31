export interface SocketUser {
  uuid: string;
  roles: string[];
}

/** Decodifica el payload de un JWT sin verificar la firma (solo para leer el id). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getUserId(payload: Record<string, unknown>): string | null {
  const candidate =
    payload.user_uuid ?? payload.uid ?? payload.uuid ?? payload.sub;
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : null;
}

/** Normaliza los roles del usuario del Rust (lista de strings, u objetos con key/name). */
function parseRoles(raw: unknown): string[] {
  const names: string[] = [];
  if (typeof raw === 'string') names.push(raw);
  else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') names.push(item);
      else if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>;
        const name = obj.key ?? obj.name ?? obj.role ?? obj.slug;
        if (typeof name === 'string') names.push(name);
      }
    }
  }
  return names;
}

/**
 * Valida el JWT del handshake contra el backend Rust (Opcion B, igual que el
 * backend Vercel). Devuelve el usuario con sus roles, o null si el token no
 * sirve. En desarrollo, DEV_SKIP_AUTH=1 permite probar el socket sin Rust.
 */
export async function validateSocketToken(
  token: string | undefined,
): Promise<SocketUser | null> {
  if (!token) return null;

  if (process.env.DEV_SKIP_AUTH === '1') {
    const payload = decodeJwtPayload(token);
    const uuid = (payload && getUserId(payload)) || 'dev-user';
    const roles = payload ? parseRoles(payload.roles) : [];
    return { uuid, roles: roles.length ? roles : ['tourist'] };
  }

  const payload = decodeJwtPayload(token);
  const userId = payload ? getUserId(payload) : null;
  if (!userId) return null;

  const base = process.env.RUST_API_URL;
  if (!base) throw new Error('Falta la variable de entorno RUST_API_URL.');

  try {
    const res = await fetch(`${base}/user/${userId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      user?: { uuid?: string; roles?: unknown };
      uuid?: string;
      roles?: unknown;
    };
    const user = data.user ?? data;
    const uuid = (user.uuid as string) ?? userId;
    return { uuid, roles: parseRoles(user.roles) };
  } catch {
    return null;
  }
}

export function hasRole(user: SocketUser, role: string): boolean {
  return user.roles.some((r) => r.toLowerCase() === role.toLowerCase());
}
