-- Run: PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f create_geocode_cache.sql
-- Caches place-name -> coordinates lookups (Nominatim/OpenStreetMap) used by the
-- "near"/geo-search feature in search_properties. Global cache (no company_id):
-- a place's coordinates are the same real-world fact regardless of which
-- tenant's client asked about it, so this is not tenant data.

BEGIN;

CREATE TABLE IF NOT EXISTS geocode_cache (
    id                BIGSERIAL PRIMARY KEY,
    query_normalized  VARCHAR(255) NOT NULL UNIQUE,
    query_original    VARCHAR(255) NOT NULL,
    lat               DOUBLE PRECISION NOT NULL,
    lon               DOUBLE PRECISION NOT NULL,
    display_name      TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
