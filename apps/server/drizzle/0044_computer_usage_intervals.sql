-- When a member's computer was in use (plan 9.5): the awake-time ledger for
-- usage billing later (src/services/computer-usage.ts).
CREATE TABLE "computer_usage_intervals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"computer_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"provider" "computer_provider" NOT NULL,
	"reason" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "computer_usage_intervals" ADD CONSTRAINT "computer_usage_intervals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_usage_intervals" ADD CONSTRAINT "computer_usage_intervals_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_usage_intervals" ADD CONSTRAINT "computer_usage_intervals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "computer_usage_intervals_owner" ON "computer_usage_intervals" USING btree ("workspace_id","owner_id","started_at");--> statement-breakpoint
CREATE INDEX "computer_usage_intervals_computer" ON "computer_usage_intervals" USING btree ("computer_id","started_at");--> statement-breakpoint
-- Row-level security as for every table with workspace_id (0023_row_level_security):
-- computer_usage_intervals is an organization's; its workspace_id-led index
-- is computer_usage_intervals_owner. The grant covers installs whose tables
-- another role made (0023's default privileges cover the rest).
GRANT SELECT, INSERT, UPDATE, DELETE ON "computer_usage_intervals" TO openbots_app;
--> statement-breakpoint
ALTER TABLE "computer_usage_intervals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "computer_usage_intervals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY organization_isolation ON "computer_usage_intervals"
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
