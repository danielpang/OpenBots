-- The plan with the dearest seat price paid for in a period (plan 21.10).
-- With paid_seats it is what the period covers: a change of plan that
-- lowers the price gives no credit, so a change back within what was paid
-- costs nothing more. Null on rows made before it: the period's plan stands in.
ALTER TABLE "billing_periods" ADD COLUMN "paid_plan" text;
