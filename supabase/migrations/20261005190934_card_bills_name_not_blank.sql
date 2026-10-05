-- Every other required name column (debts.name, savings_balances.name,
-- emis.card_or_bank, subscriptions.service, categories.label) refuses a blank
-- value; card_bills.name was only NOT NULL. The store already rejects a blank
-- card name ("Each card needs a name"), so this only stops a bug or the
-- importer from writing one (supabase-migrations rule 4).
alter table card_bills add constraint card_bills_name_not_blank check (length(btrim(name)) > 0);
