-- When Discard removed a coding session's log (services/coder-log.ts). With
-- the s3 storage driver another machine may still hold a spool of the log
-- from before; it is dropped rather than stored. Null for every row written
-- before, which loads as a log never discarded.
ALTER TABLE "coding_sessions" ADD COLUMN "log_discarded_at" timestamp with time zone;
