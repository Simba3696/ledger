-- LOCAL STACK ONLY (applied by `supabase db reset`; never pushed to a hosted
-- project). Default categories match server/src/domain/categoryColors.ts's
-- DEFAULT_CATEGORIES so a fresh stack behaves like a fresh Excel install.
insert into categories (id, label, bg, fg, position) values
  ('food',           'Food',           '#FFFF00', '#3d3d00', 0),
  ('transportation', 'Transportation', '#00B0F0', '#00303d', 1),
  ('rent',           'Rent',           '#FFC000', '#4d3300', 2),
  ('other',          'Other',          '#FF0000', '#ffffff', 3);
