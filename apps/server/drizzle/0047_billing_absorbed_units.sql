-- Overage time Stripe is never told about (plan 21.10): used past the
-- allowance while overage was not allowed, or past the spending ceiling.
-- Allowing overage or raising the ceiling later does not bill it.
ALTER TABLE "billing_periods" ADD COLUMN "absorbed_units" integer DEFAULT 0 NOT NULL;
