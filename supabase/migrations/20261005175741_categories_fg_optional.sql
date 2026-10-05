-- fg is optional, auto-derived from bg on read (domain/categoryColors.ts's
-- deriveForegroundColor), exactly as the Excel edition let a categories.json
-- entry omit it. The init schema made it NOT NULL; relax that.
--
-- The existing hex check stays: a CHECK passes when its expression is null,
-- so `fg ~ '^#[0-9A-Fa-f]{6}$'` still rejects a malformed non-null colour
-- while allowing null.
alter table categories alter column fg drop not null;
