import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | undefined;

/** Pool a la MISMA base PostgreSQL del Rust (tablas nuevas en schema `ext`). */
export function getPool(): pg.Pool {
  if (!pool) {
    const raw = process.env.DATABASE_URL;
    if (!raw) throw new Error('Falta la variable de entorno DATABASE_URL.');

    // Igual que el backend Vercel: DigitalOcean usa CA propio y las versiones
    // nuevas de pg tratan sslmode=require como verify-full. Sacamos sslmode del
    // string y configuramos el SSL a mano (cifrado, sin verificar el CA).
    const url = new URL(raw);
    const useSsl =
      url.searchParams.has('sslmode') ||
      url.hostname.includes('ondigitalocean.com');
    url.searchParams.delete('sslmode');

    pool = new Pool({
      connectionString: url.toString(),
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
      max: 5,
      idleTimeoutMillis: 10000,
    });
  }
  return pool;
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await getPool().query(text, params);
  return result.rows as T[];
}
