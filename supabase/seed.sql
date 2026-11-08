-- Operator allowlist: only these emails can use the dashboard (Supabase auth + RLS).
-- Replace with the real operator emails before running `supabase db reset` / seeding.
insert into public.operators (email, role) values
  ('operator-1@example.com', 'admin'),
  ('operator-2@example.com', 'operator')
on conflict (email) do nothing;
