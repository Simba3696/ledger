-- Years that have ever been written to. In the Excel edition a year existed
-- once its workbook file did, and deleting every row kept the file, so the
-- year's months still read as empty rather than missing. Here a year with
-- expenses or month locks plainly exists; this table remembers a year whose
-- rows have all been deleted since, so it doesn't fall back to a 404.
-- appendEntry (the one write that creates a year) inserts here; nothing
-- deletes from it.
create table ledger_years (
  year int primary key check (year >= 2018)
);

alter table ledger_years enable row level security;

-- Years that already have data.
insert into ledger_years (year)
  select year from expenses
  union
  select year from month_locks where year >= 2018;
