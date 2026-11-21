-- App sign-in through the browser (services/app-sign-in.ts). A pairing made
-- for it carries the app's PKCE challenge; every row written before has none
-- and stays a QR pairing. It also says which app the code is for (ios or
-- desktop), so each route takes only its own app's codes. A Mac app signed
-- in that way is a device holding a session instead of an API key; every
-- device written before has no session.
ALTER TABLE "device_pairings" ADD COLUMN "code_challenge" text;--> statement-breakpoint
ALTER TABLE "device_pairings" ADD COLUMN "app_platform" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_session_id" UNIQUE("session_id");--> statement-breakpoint
-- The organization of the device that holds a session (db/scope.ts,
-- sessionDeviceWorkspace): a Mac signed in through the browser may switch
-- its session to another organization, and its device stays in the one it
-- was made in. Asked only with a session the server has in hand (a request's
-- own, or one being deleted); the device is then read and changed there.
CREATE FUNCTION openbots_session_device_workspace(p_session uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT workspace_id FROM devices WHERE session_id = p_session $$;
--> statement-breakpoint
-- A new owner needs CREATE on the schema to take a function; only for this one.
GRANT CREATE ON SCHEMA public TO openbots_system;
--> statement-breakpoint
ALTER FUNCTION openbots_session_device_workspace(uuid) OWNER TO openbots_system;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM openbots_system;
--> statement-breakpoint
REVOKE ALL ON FUNCTION openbots_session_device_workspace(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION openbots_session_device_workspace(uuid) TO openbots_app;
