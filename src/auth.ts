export interface SocketUser {
  uuid: string;
  roles: string[];
  /** Nombre para mostrar (nombre + apellido, o email). Puede faltar. */
  name?: string;
  /** UUID de la foto de perfil (media del Rust). Puede faltar. */
  avatar?: string;
}

/** Arma el nombre para mostrar a partir del usuario del Rust. */
function buildDisplayName(user: {
  name?: unknown;
  last_name?: unknown;
  email?: unknown;
}): string | undefined {
  const parts = [user.name, user.last_name]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim());
  const full = parts.join(' ').trim();
  if (full.length > 0) return full;
  if (typeof user.email === 'string' && user.email.length > 0) {
    return user.email;
  }
  return undefined;
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

  // Igual que el backend Vercel (lib/auth.ts): puede haber mas de un entorno
  // Rust, produccion (RUST_API_URL) y staging (RUST_API_URL_FALLBACK). Se valida
  // contra produccion primero y, si no valida, contra staging. Al salir en vivo
  // se puede dejar solo produccion quitando el fallback.
  const bases = [
    process.env.RUST_API_URL,
    process.env.RUST_API_URL_FALLBACK,
  ].filter((b): b is string => typeof b === 'string' && b.length > 0);
  if (bases.length === 0) {
    throw new Error('Falta la variable de entorno RUST_API_URL.');
  }

  for (const base of bases) {
    try {
      const res = await fetch(`${base}/user/${userId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        user?: {
          uuid?: string;
          roles?: unknown;
          name?: unknown;
          last_name?: unknown;
          email?: unknown;
          avatar?: unknown;
        };
        uuid?: string;
        roles?: unknown;
        name?: unknown;
        last_name?: unknown;
        email?: unknown;
        avatar?: unknown;
      };
      const user = data.user ?? data;
      const uuid = (user.uuid as string) ?? userId;
      return {
        uuid,
        roles: parseRoles(user.roles),
        name: buildDisplayName(user),
        avatar: typeof user.avatar === 'string' ? user.avatar : undefined,
      };
    } catch {
      // Probar el siguiente entorno.
    }
  }
  return null;
}

export function hasRole(user: SocketUser, role: string): boolean {
  return user.roles.some((r) => r.toLowerCase() === role.toLowerCase());
}
