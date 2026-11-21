-- The old machine of a full reset, until it is deleted
-- (src/services/computer-retire.ts): a full reset deletes the old machine,
-- and this record lets the retired-computers job retry a deletion that
-- failed or never ran.
--
-- Its journal `when` sits just after 0044's and before the billing and
-- artifact migrations stacked on this branch (now 0046 to 0049), so their
-- timestamps run in order after this one and a database that has this one
-- still applies them.
--
-- `computers.machine_key` names a computer's machine where the provider
-- names it (Sprites): a full reset gives the computer a new key, so its next
-- machine is a new one while the old one is being deleted. Its own column, so
-- no write of the whole `spec` can drop it.
--
-- `computers.status_at` is when the status last changed (the trigger below
-- keeps it), so a busy status a dead process left behind is found by its age
-- from any process; `computers.generation` is bumped by every reset, stop,
-- start and claim, and a provisioning job writes only while it is unchanged
-- (services/computer.ts).
ALTER TABLE "computers" ADD COLUMN "machine_key" text;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "status_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE "retired_computers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"computer_id" uuid,
	"provider" "computer_provider" NOT NULL,
	"provider_ref" text NOT NULL,
	"status" text NOT NULL,
	"retired_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"gave_up_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"deleted_at" timestamp with time zone,
	"fence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retired_computers" ADD CONSTRAINT "retired_computers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retired_computers" ADD CONSTRAINT "retired_computers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retired_computers" ADD CONSTRAINT "retired_computers_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retired_computers_owner" ON "retired_computers" USING btree ("workspace_id","owner_id","retired_at");--> statement-breakpoint
CREATE INDEX "retired_computers_due" ON "retired_computers" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "retired_computers_fence" ON "retired_computers" USING btree ("created_at") WHERE fence is not null;
--> statement-breakpoint
-- Row-level security as for every table with workspace_id (0023_row_level_security):
-- retired_computers is an organization's; its workspace_id-led index is
-- retired_computers_owner. The grant covers installs whose tables another
-- role made (0023's default privileges cover the rest).
GRANT SELECT, INSERT, UPDATE, DELETE ON "retired_computers" TO openbots_app;
--> statement-breakpoint
ALTER TABLE "retired_computers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "retired_computers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY organization_isolation ON "retired_computers"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- The fences every process enforces (services/computer-fence.ts): the agent
-- token hash of each machine a reset took off a computer, in any
-- organization, so a process that missed the bus message, or started after
-- it, still refuses that token, and ends what it runs on that machine (the
-- owner's coding sessions and stdio connectors). Hashes and ids only; its
-- owner reads only those columns.
GRANT SELECT ("computer_id", "owner_id", "workspace_id", "fence", "created_at") ON "retired_computers" TO openbots_system;
--> statement-breakpoint
CREATE POLICY system_read ON "retired_computers" FOR SELECT TO openbots_system USING (true);
--> statement-breakpoint
CREATE FUNCTION openbots_computer_fences(p_since timestamptz) RETURNS TABLE (computer_id uuid, owner_id uuid, workspace_id uuid, fence text, created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT r.computer_id, r.owner_id, r.workspace_id, r.fence, r.created_at
    FROM retired_computers r
    WHERE r.fence IS NOT NULL AND r.created_at >= p_since
  $$;
--> statement-breakpoint
-- A new owner needs CREATE on the schema to take a function; only for this one.
GRANT CREATE ON SCHEMA public TO openbots_system;
--> statement-breakpoint
ALTER FUNCTION openbots_computer_fences(timestamptz) OWNER TO openbots_system;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM openbots_system;
--> statement-breakpoint
REVOKE ALL ON FUNCTION openbots_computer_fences(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION openbots_computer_fences(timestamptz) TO openbots_app;
--> statement-breakpoint
-- `computers.status_at` follows every status change, unless the change sets
-- it itself.
CREATE FUNCTION openbots_computers_status_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
    BEGIN
      IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status_at IS NOT DISTINCT FROM OLD.status_at THEN
        NEW.status_at := clock_timestamp();
      END IF;
      RETURN NEW;
    END
  $$;
--> statement-breakpoint
CREATE TRIGGER computers_status_at BEFORE UPDATE ON "computers"
  FOR EACH ROW EXECUTE FUNCTION openbots_computers_status_at();
