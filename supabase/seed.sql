-- LOCAL STACK ONLY (applied by `supabase db reset`; never pushed to a hosted
-- project). Default categories match server/src/domain/categoryColors.ts's
-- DEFAULT_CATEGORIES so a fresh stack behaves like a fresh Excel install.
insert into categories (id, label, bg, fg, position) values
  ('food',           'Food',           '#FFFF00', '#3d3d00', 0),
  ('transportation', 'Transportation', '#00B0F0', '#00303d', 1),
  ('rent',           'Rent',           '#FFC000', '#4d3300', 2),
  ('other',          'Other',          '#FF0000', '#ffffff', 3);

-- The deployment owner, for local dev and e2e only: owner@example.test with
-- the password `local-owner-password` (local stack only; a hosted project's
-- owner is created from the dashboard, LLD §6). server/.env's OWNER_EMAIL
-- names this address. GoTrue scans the token columns into plain strings, so
-- they must be '' rather than null or sign-in fails with "Database error
-- querying schema". Idempotent: e2e/localDb.ts re-runs this file after
-- truncating only the public tables, which leaves auth.users in place.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values (
  '00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'owner@example.test',
  extensions.crypt('local-owner-password', extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}', '{}', now(), now(),
  '', '', '', ''
) on conflict (id) do nothing;

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
values (
  '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001', 'email',
  '{"sub":"00000000-0000-4000-8000-000000000001","email":"owner@example.test","email_verified":true}',
  now(), now(), now()
) on conflict (id) do nothing;
