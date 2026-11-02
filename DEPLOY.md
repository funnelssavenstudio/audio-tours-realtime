# Despliegue del servicio realtime en DigitalOcean

Servicio `socket.io` (chat en vivo, ubicacion de turistas, push de audio del guia).
Es un proceso que queda corriendo (long-running), por eso NO va en Vercel: va en
el **DigitalOcean App Platform** del cliente.

Repo: `github.com/funnelssavenstudio/audio-tours-realtime` (rama `master`).
Ya quedan listos en el repo: `Dockerfile`, `.dockerignore` y `.do/app.yaml`.

---

## Variables de entorno

| Variable | Valor | Nota |
|---|---|---|
| `DATABASE_URL` | connection string de la base del cliente (`...ondigitalocean.com:25060/defaultdb?sslmode=require`) | **SECRET**. La misma base que usa el Rust y el backend de Vercel. La pass se saca del panel DO de la base. |
| `RUST_API_URL` | `https://app.audiotoursnewyork.com/api/v1` | Para validar el token del handshake contra el Rust. |
| `PORT` | lo inyecta DO solo | El server lee `process.env.PORT` (3001 por defecto). No hace falta setearlo. |
| `DEV_SKIP_AUTH` | **NO setear** | Solo para pruebas locales. En produccion debe quedar ausente. |

---

## Opcion A: panel de DigitalOcean (recomendada)

1. Entrar al equipo de DigitalOcean **del cliente** (donde esta la base `db-postgresql-gours-app`).
2. **Apps -> Create App**.
3. Origen: **GitHub -> repo `funnelssavenstudio/audio-tours-realtime`**, rama `master`.
   - Si DO no ve el repo, autorizar la app de GitHub de DigitalOcean para esa organizacion.
4. DO detecta el `Dockerfile` solo. Confirmar que el recurso es un **Web Service**
   (no Worker), con health check en `/health`.
5. En **Environment Variables** cargar `DATABASE_URL` (marcar **Encrypt** = secret) y
   `RUST_API_URL`. NO agregar `DEV_SKIP_AUTH`.
6. Elegir el plan (Basic mas chico alcanza; ~US$5/mes) y la region **NYC**.
7. **Create Resources**. El primer deploy tarda unos minutos.
8. Al terminar queda una URL tipo `https://audio-tours-realtime-xxxxx.ondigitalocean.app`.

## Opcion B: doctl (linea de comandos)

```bash
doctl apps create --spec .do/app.yaml
# cargar el secret DATABASE_URL en el panel o:
doctl apps update <APP_ID> --spec .do/app.yaml
```

---

## Red de la base de datos

El servicio se conecta a la base del cliente por `DATABASE_URL`. Hoy la base acepta
conexiones de cualquier origen (inbound abierto). Lo prolijo despues del deploy:
en la base (Managed Database -> Settings -> **Trusted Sources**) agregar el App
como fuente confiable, y asi cerrar el inbound abierto. El SSL ya esta resuelto en
el codigo (DO usa CA propio; `src/db.ts` saca `sslmode` y cifra sin verificar el CA).

---

## Verificar que quedo bien

```bash
curl https://<URL-del-app>/health
# -> {"status":"OK","service":"audio-tours-realtime","time":"..."}
```

Para una prueba de socket con token real, usar `test-client.mjs` (apuntando la URL al
deploy) con un JWT fresco del Rust.

---

## Conectar la app (paso final)

Una vez online, poner la URL del deploy en el cliente de socket de la app:
`app-actual/lib/api/realtime_client.dart` -> `baseUrl` (hoy vacio -> `isConfigured` false).
Recompilar el APK. Recien ahi el chat en vivo / ubicacion / push de audio funcionan
punta a punta (el historial de chat por HTTP ya anda contra el backend de Vercel).

---

## Nota sobre el backend Next.js

El backend (`backend-nuevo/`) hoy corre en un Vercel de prueba de Saven
(`audio-tours-backend.vercel.app`). Cuando se migre a produccion, puede ir al mismo
App Platform del cliente (otro Web Service, buildpack de Node o Dockerfile propio),
reusando `DATABASE_URL` y `RUST_API_URL`. Es un paso aparte de este servicio.
