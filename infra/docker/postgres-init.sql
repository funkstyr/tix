-- Per-service schemas and roles for the tix slice.
-- Pulls each role's password from a container env var so secrets stay out of git.
-- Idempotent: docker-entrypoint only runs this on a fresh data volume.

\getenv auth_password AUTH_PASSWORD
\getenv tickets_password TICKETS_PASSWORD
\getenv orders_password ORDERS_PASSWORD
\getenv expiration_password EXPIRATION_PASSWORD

REVOKE ALL ON SCHEMA public FROM PUBLIC;

CREATE ROLE auth_user WITH LOGIN PASSWORD :'auth_password';
CREATE SCHEMA auth AUTHORIZATION auth_user;

CREATE ROLE tickets_user WITH LOGIN PASSWORD :'tickets_password';
CREATE SCHEMA tickets AUTHORIZATION tickets_user;

CREATE ROLE orders_user WITH LOGIN PASSWORD :'orders_password';
CREATE SCHEMA orders AUTHORIZATION orders_user;

CREATE ROLE expiration_user WITH LOGIN PASSWORD :'expiration_password';
CREATE SCHEMA expiration AUTHORIZATION expiration_user;

-- Drizzle's `CREATE SCHEMA IF NOT EXISTS` (emitted by drizzle-kit at the top
-- of each service's initial migration) requires CREATE on the database even
-- when the schema already exists; per-service roles run their own migrations,
-- so each needs that privilege. They still only own their own schema.
GRANT CREATE ON DATABASE tix TO auth_user, tickets_user, orders_user, expiration_user;
