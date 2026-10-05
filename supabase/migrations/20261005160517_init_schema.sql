-- Initial schema for the hosted edition. See docs/architecture/LLD.md §2.
-- Money: numeric(14,2). Calendar dates: date (never timestamptz — ADR-0005).
-- Every table: RLS enabled with zero policies, so Supabase's auto-generated
-- Data API exposes nothing; only the API function (postgres role) connects.

create table categories (
  id        text primary key,
  label     text not null check (length(btrim(label)) > 0),
  bg        text not null check (bg ~ '^#[0-9A-Fa-f]{6}$'),
  fg        text not null check (fg ~ '^#[0-9A-Fa-f]{6}$'),
  position  int  not null
);

create table expenses (
  id          bigint generated always as identity primary key,
  year        int  not null check (year >= 2018),
  month       int  not null check (month between 1 and 12),
  position    int  not null check (position >= 0),
  amount      numeric(14,2) not null check (amount > 0),
  remarks     text not null check (length(btrim(remarks)) > 0),
  -- Null only for imported rows whose fill colour matched no category.
  category_id text references categories (id) on update cascade on delete restrict,
  -- Null = cash. 'CC' (or an imported note like 'CC (200)') = paid by card.
  card_note   text,
  -- Deferred so a reorder can shuffle positions within one transaction.
  constraint expenses_position_unique unique (year, month, position) deferrable initially deferred
);
create index expenses_year_month on expenses (year, month);

-- A row present means the month is locked against edits.
create table month_locks (
  year  int not null check (year >= 2018),
  month int not null check (month between 1 and 12),
  primary key (year, month)
);

create table finance_months (
  year         int not null check (year >= 2018),
  month        int not null check (month between 1 and 12),
  salary       numeric(14,2),
  other_income numeric(14,2),
  primary key (year, month)
);

-- A month's savings snapshot. No rows for a month = not entered that month
-- (carry-forward then uses the most recent month that does have rows).
create table savings_balances (
  year     int  not null,
  month    int  not null,
  position int  not null check (position >= 0),
  name     text not null check (length(btrim(name)) > 0),
  amount   numeric(14,2) not null,
  primary key (year, month, position),
  foreign key (year, month) references finance_months (year, month) on delete cascade
);

-- Signed: positive = you owe, negative = owed to you.
create table debts (
  id     bigint generated always as identity primary key,
  name   text not null check (length(btrim(name)) > 0),
  amount numeric(14,2) not null
);

create table emis (
  id                 bigint generated always as identity primary key,
  card_or_bank       text not null check (length(btrim(card_or_bank)) > 0),
  emi_amount         numeric(14,2) not null check (emi_amount > 0),
  due_day            int  not null check (due_day between 1 and 31),
  total_amount       numeric(14,2) not null check (total_amount >= 0),
  remarks            text not null default '',
  remaining_as_of    numeric(14,2) not null check (remaining_as_of >= 0),
  as_of_date         date not null,
  until_target       date,
  interest_rate      numeric(6,3) check (interest_rate between 0 and 100),
  foreclosure_charge numeric(6,3) check (foreclosure_charge between 0 and 100)
);

create table subscriptions (
  id            bigint generated always as identity primary key,
  service       text not null check (length(btrim(service)) > 0),
  amount        numeric(14,2) not null check (amount > 0),
  duration      text not null check (duration in ('Monthly', 'Yearly')),
  expiry_anchor date not null,
  card_or_bank  text not null default 'N/A'
);

create table card_bills (
  id       bigint generated always as identity primary key,
  year     int  not null check (year >= 2018),
  month    int  not null check (month between 1 and 12),
  position int  not null check (position >= 0),
  name     text not null,
  due      numeric(14,2) not null default 0,
  paid     numeric(14,2) not null default 0,
  due_date date,
  settled  boolean not null default false,
  unique (year, month, position)
);

alter table categories       enable row level security;
alter table expenses         enable row level security;
alter table month_locks      enable row level security;
alter table finance_months   enable row level security;
alter table savings_balances enable row level security;
alter table debts            enable row level security;
alter table emis             enable row level security;
alter table subscriptions    enable row level security;
alter table card_bills       enable row level security;
