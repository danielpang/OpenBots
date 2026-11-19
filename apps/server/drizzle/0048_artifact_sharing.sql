-- Artifact sharing and the artifact host (plan 21.11). Every Artifact stays
-- private: the new column's default is `private`, so rows written before this
-- load as they were. A public Artifact names the version a person confirmed.
CREATE TYPE "public"."artifact_visibility" AS ENUM('private', 'org', 'public');--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "visibility" "artifact_visibility" DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "shared_by" uuid;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "shared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "public_version_id" uuid;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "taken_down_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_shared_by_users_id_fk" FOREIGN KEY ("shared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_public_version_id_artifact_versions_id_fk" FOREIGN KEY ("public_version_id") REFERENCES "public"."artifact_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_workspace_visibility" ON "artifacts" USING btree ("workspace_id","visibility");--> statement-breakpoint
-- Each Bot's name on the artifact domain, unique across organizations (bot
-- handles are only unique per member). Existing Bots get their handle's
-- letters and digits and eight hex digits of their id, short enough that
-- `<slug>--<organization slug>` fits a 63 character DNS label; two Bots
-- that would still collide take twelve other digits of their id instead.
-- bots and workspaces force row-level security on their owner (0023), so the
-- backfill lifts it for this transaction and puts it back.
ALTER TABLE "bots" ADD COLUMN "public_slug" text;--> statement-breakpoint
ALTER TABLE "bots" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspaces" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
WITH parts AS (
  SELECT b.id,
    rtrim(left(
      coalesce(nullif(trim(both '-' from regexp_replace(lower(b.handle), '[^a-z0-9]+', '-', 'g')), ''), 'bot'),
      greatest(0, least(31, 61 - length(w.slug)) - 9)
    ), '-') AS part,
    replace(b.id::text, '-', '') AS hex
  FROM "bots" b JOIN "workspaces" w ON w.id = b.workspace_id
), candidates AS (
  SELECT id, part, hex,
    concat_ws('-', nullif(part, ''), substr(hex, 1, 8)) AS slug
  FROM parts
), ranked AS (
  SELECT id, part, hex, slug, count(*) OVER (PARTITION BY slug) AS taken
  FROM candidates
)
UPDATE "bots" SET "public_slug" = CASE
    WHEN ranked.taken > 1 THEN concat_ws('-', nullif(ranked.part, ''), substr(ranked.hex, 21, 12))
    ELSE ranked.slug
  END
FROM ranked WHERE ranked.id = "bots".id;--> statement-breakpoint
ALTER TABLE "bots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspaces" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bots" ALTER COLUMN "public_slug" SET DEFAULT ('b' || substr(md5(gen_random_uuid()::text), 1, 11));--> statement-breakpoint
ALTER TABLE "bots" ALTER COLUMN "public_slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_public_slug_unique" UNIQUE("public_slug");--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_public_slug_format" CHECK ("bots"."public_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("bots"."public_slug") BETWEEN 3 AND 40);--> statement-breakpoint
-- The artifact host's first question (src/artifact-host): a request names a
-- Bot by its public slug, not an organization. This answers which
-- organization that Bot is in, and nothing else; the request is then served
-- in that organization's scope (db/scope.ts). openbots_system already reads
-- bots (0023).
CREATE FUNCTION openbots_artifact_host_workspace(p_slug text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT workspace_id FROM bots WHERE public_slug = p_slug $$;
--> statement-breakpoint
-- A new owner needs CREATE on the schema to take a function; only for this one.
GRANT CREATE ON SCHEMA public TO openbots_system;
--> statement-breakpoint
ALTER FUNCTION openbots_artifact_host_workspace(text) OWNER TO openbots_system;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM openbots_system;
--> statement-breakpoint
REVOKE ALL ON FUNCTION openbots_artifact_host_workspace(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION openbots_artifact_host_workspace(text) TO openbots_app;
