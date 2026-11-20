-- Artifact sharing and the artifact host (plan 21.11). Every Artifact stays
-- private: the new column's default is `private`, so rows written before this
-- load as they were. A shared Artifact always shows its latest version.
CREATE TYPE "public"."artifact_visibility" AS ENUM('private', 'org', 'public');--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "visibility" "artifact_visibility" DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "shared_by" uuid;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "shared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "taken_down_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_shared_by_users_id_fk" FOREIGN KEY ("shared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_workspace_visibility" ON "artifacts" USING btree ("workspace_id","visibility");--> statement-breakpoint
-- Each Bot's name on the artifact domain, unique across organizations (bot
-- handles are only unique per member). Existing Bots get their handle's
-- letters and digits and eight hex digits of their id, short enough that
-- `<slug>--<organization slug>` fits a 63 character DNS label; two Bots
-- that would still collide take up to twelve other digits of their id
-- instead, with the handle cut so the label still fits. An organization
-- whose slug leaves no room (migration 0021 kept whole names) still gets
-- valid slugs; the app says its address is too long for a link.
-- bots and workspaces force row-level security on their owner (0023), so the
-- backfill lifts it for this transaction and puts it back.
ALTER TABLE "bots" ADD COLUMN "public_slug" text;--> statement-breakpoint
ALTER TABLE "bots" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspaces" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
WITH parts AS (
  SELECT b.id,
    coalesce(nullif(trim(both '-' from regexp_replace(lower(b.handle), '[^a-z0-9]+', '-', 'g')), ''), 'bot') AS letters,
    least(31, 61 - length(w.slug)) AS room,
    replace(b.id::text, '-', '') AS hex
  FROM "bots" b JOIN "workspaces" w ON w.id = b.workspace_id
), candidates AS (
  SELECT id, letters, room, hex,
    concat_ws('-', nullif(rtrim(left(letters, greatest(0, room - 9)), '-'), ''), substr(hex, 1, 8)) AS slug,
    least(12, greatest(8, room)) AS digits
  FROM parts
), ranked AS (
  SELECT id, letters, room, hex, slug, digits, count(*) OVER (PARTITION BY slug) AS taken
  FROM candidates
)
UPDATE "bots" SET "public_slug" = CASE
    WHEN ranked.taken > 1 THEN concat_ws('-',
      nullif(rtrim(left(ranked.letters, greatest(0, ranked.room - ranked.digits - 1)), '-'), ''),
      substr(ranked.hex, 33 - ranked.digits, ranked.digits))
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
--> statement-breakpoint
-- A Bot's share request is used once (services/artifact-sharing.ts): the
-- approval row records when, under the Artifact's lock. Null for every
-- other approval, and for rows written before this.
ALTER TABLE "approvals" ADD COLUMN "consumed_at" timestamp with time zone;
