-- Billing on the managed service (plan 21.10; ee/server billing): an
-- organization's plan and limits, its Stripe events, its billing periods with
-- their allowance and what Stripe was told, the usage ledger, and members'
-- computer hour caps. Only the managed build reads or writes them.
CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"stripe_event_id" text NOT NULL,
	"type" text NOT NULL,
	"activity" text,
	"from_plan" text,
	"to_plan" text,
	"amount_total" bigint,
	"currency" text,
	"subscription_id" text,
	"invoice_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_events_stripe_event_id_unique" UNIQUE("stripe_event_id")
);
--> statement-breakpoint
CREATE TABLE "billing_member_limits" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"cap_hours" numeric(8, 1),
	"personal_hours" numeric(8, 1),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_member_limits_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "billing_periods" (
	"workspace_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"plan" text NOT NULL,
	"base_seats" integer NOT NULL,
	"paid_seats" integer NOT NULL,
	"allowance_seconds" bigint NOT NULL,
	"used_seconds" bigint DEFAULT 0 NOT NULL,
	"reported_units" integer DEFAULT 0 NOT NULL,
	"report_seq" integer DEFAULT 0 NOT NULL,
	"notified_75" boolean DEFAULT false NOT NULL,
	"notified_90" boolean DEFAULT false NOT NULL,
	"notified_stopped" boolean DEFAULT false NOT NULL,
	"overage_notified_usd" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_periods_workspace_id_period_start_pk" PRIMARY KEY("workspace_id","period_start")
);
--> statement-breakpoint
CREATE TABLE "billing_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"interval_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"user_id" uuid NOT NULL,
	"user_name" text,
	"seconds" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_usage_interval_period" UNIQUE("interval_id","period_start")
);
--> statement-breakpoint
CREATE TABLE "organization_billing" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"plan" text DEFAULT 'none' NOT NULL,
	"status" text,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"billed_seats" integer,
	"overage_policy" text DEFAULT 'stop' NOT NULL,
	"ceiling_usd" numeric(12, 2),
	"period_anchor" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"last_event_at" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_billing_customer" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_member_limits" ADD CONSTRAINT "billing_member_limits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_member_limits" ADD CONSTRAINT "billing_member_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_periods" ADD CONSTRAINT "billing_periods_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_usage" ADD CONSTRAINT "billing_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_events_workspace" ON "billing_events" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "billing_usage_period" ON "billing_usage" USING btree ("workspace_id","period_start","user_id");--> statement-breakpoint
CREATE INDEX "billing_usage_ended" ON "billing_usage" USING btree ("workspace_id","ended_at");
--> statement-breakpoint
-- Row-level security as for every table with workspace_id (0023_row_level_security):
-- each is an organization's. Their workspace_id-led indexes are the primary
-- keys of organization_billing, billing_periods and billing_member_limits,
-- billing_events_workspace and billing_usage_period. The grant covers
-- installs whose tables another role made (0023's default privileges cover the rest).
GRANT SELECT, INSERT, UPDATE, DELETE ON "organization_billing", "billing_events", "billing_periods", "billing_usage", "billing_member_limits" TO openbots_app;
--> statement-breakpoint
DO $$
DECLARE
  t text;
  isolation text := 'workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid';
BEGIN
  FOREACH t IN ARRAY ARRAY['organization_billing', 'billing_events', 'billing_periods', 'billing_usage', 'billing_member_limits']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY organization_isolation ON %I USING (%s) WITH CHECK (%s)', t, isolation, isolation);
  END LOOP;
END $$;
--> statement-breakpoint
-- Stripe's webhook names a customer, not an organization: this is its first
-- question, and the event is then applied in that organization's scope
-- (db/scope.ts). Read only, the two columns it needs.
GRANT SELECT ("workspace_id", "stripe_customer_id") ON "organization_billing" TO openbots_system;
--> statement-breakpoint
CREATE POLICY system_read ON "organization_billing" FOR SELECT TO openbots_system USING (true);
--> statement-breakpoint
CREATE FUNCTION openbots_billing_customer_workspace(p_customer text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT workspace_id FROM organization_billing WHERE stripe_customer_id = p_customer $$;
--> statement-breakpoint
-- A new owner needs CREATE on the schema to take a function; only for this one.
GRANT CREATE ON SCHEMA public TO openbots_system;
--> statement-breakpoint
ALTER FUNCTION openbots_billing_customer_workspace(text) OWNER TO openbots_system;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM openbots_system;
--> statement-breakpoint
REVOKE ALL ON FUNCTION openbots_billing_customer_workspace(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION openbots_billing_customer_workspace(text) TO openbots_app;
