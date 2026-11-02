# Servicio realtime (socket.io) de Audio Tours NY.
# Build multi-stage: compila TypeScript en una etapa y corre solo lo necesario
# en la etapa final (imagen chica, sin dev-dependencies).

# ---- Build ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# El server escucha en process.env.PORT (DigitalOcean lo inyecta); 3001 por defecto.
EXPOSE 3001
CMD ["node", "dist/server.js"]
