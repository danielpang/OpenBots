-- App sign-in through the browser (services/app-sign-in.ts). A pairing made
-- for it carries the app's PKCE challenge; every row written before has none
-- and stays a QR pairing. A Mac app signed in that way is a device holding a
-- session instead of an API key; every device written before has no session.
ALTER TABLE "device_pairings" ADD COLUMN "code_challenge" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_session_id" UNIQUE("session_id");