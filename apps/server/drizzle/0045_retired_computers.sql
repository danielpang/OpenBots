-- Machines a full reset took out of service but kept for 7 days, so support
-- can restore one, then deleted for good (src/services/computer-retire.ts).
--
-- Its journal `when` sits just after 0044's and before the billing and
-- artifact migrations stacked on this branch (now 0046 to 0049), so their
-- timestamps run in order after this one and a database that has this one
-- still applies them.
--
-- `computers.machine_key` names a computer's machine where the provider
-- names it (Sprites): a full reset that keeps the old machine gives the
-- computer a new key. Its own column, so no write of the whole `spec` can drop
-- it.
ALTER TABLE "computers" ADD COLUMN "machine_key" text;--> statement-breakpoint
CREATE TABLE "retired_computers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"computer_id" uuid,
	"provider" "computer_provider" NOT NULL,
	"provider_ref" text NOT NULL,
	"machine_key" text,
	"agent_url" text,
	"checkpoint_id" text,
	"status" text NOT NULL,
	"retired_at" timestamp with time zone NOT NULL,
	"delete_after" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"sealed_at" timestamp with time zone,
	"gave_up_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"deleted_at" timestamp with time zone,
	"restored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retired_computers" ADD CONSTRAINT "retired_computers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retired_computers" ADD CONSTRAINT "retired_computers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retired_computers" ADD CONSTRAINT "retired_computers_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retired_computers_owner" ON "retired_computers" USING btree ("workspace_id","owner_id","retired_at");--> statement-breakpoint
CREATE INDEX "retired_computers_due" ON "retired_computers" USING btree ("status","delete_after");--> statement-breakpoint
CREATE UNIQUE INDEX "retired_computers_live_ref" ON "retired_computers" USING btree ("provider","provider_ref") WHERE status in ('retiring', 'retired', 'deleting', 'restoring');
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
-- Whether a machine is any member's computer, or about to be made one, in
-- any organization: the deletion job asks before it deletes a retired
-- machine (services/computer-retire.ts `isCurrent`), and works in one
-- organization's scope. A yes or no, nothing more; its owner reads only the
-- columns it needs.
GRANT SELECT ("id", "provider", "container_id", "machine_key") ON "computers" TO openbots_system;
--> statement-breakpoint
CREATE POLICY system_read ON "computers" FOR SELECT TO openbots_system USING (true);
--> statement-breakpoint
CREATE FUNCTION openbots_machine_in_use(p_provider computer_provider, p_ref text, p_key text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT FROM computers
      WHERE provider = p_provider
        AND (container_id = p_ref OR (p_key IS NOT NULL AND coalesce(machine_key, id::text) = p_key))
    )
  $$;
--> statement-breakpoint
-- A new owner needs CREATE on the schema to take a function; only for this one.
GRANT CREATE ON SCHEMA public TO openbots_system;
--> statement-breakpoint
ALTER FUNCTION openbots_machine_in_use(computer_provider, text, text) OWNER TO openbots_system;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM openbots_system;
--> statement-breakpoint
REVOKE ALL ON FUNCTION openbots_machine_in_use(computer_provider, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION openbots_machine_in_use(computer_provider, text, text) TO openbots_app;
