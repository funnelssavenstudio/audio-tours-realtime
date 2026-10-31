-- Migracion 005: ubicacion de turistas en vivo (modulo realtime).
-- Una fila por turista y evento (upsert de la ultima posicion, sin historial).
-- Usa geography(Point,4326) de PostGIS, consistente con el Rust.

CREATE SCHEMA IF NOT EXISTS ext;

CREATE TABLE IF NOT EXISTS ext.tourist_location (
  uuid         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_uuid   uuid NOT NULL,
  user_uuid    uuid NOT NULL,
  location     geography(Point, 4326) NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_uuid, user_uuid)
);

CREATE INDEX IF NOT EXISTS idx_tourist_location_event ON ext.tourist_location (event_uuid);
