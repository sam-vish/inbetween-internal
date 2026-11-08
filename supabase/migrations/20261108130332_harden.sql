-- Follow-up after Supabase advisors on the first deploy:
--  * is_operator() moves to a schema PostgREST does not expose (no /rest/v1/rpc/is_operator)
--  * covering indexes for foreign keys

create schema if not exists private;
grant usage on schema private to authenticated;

create or replace function private.is_operator() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.operators o
    where lower(o.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke execute on function private.is_operator() from public, anon;
grant execute on function private.is_operator() to authenticated;

alter policy operators_read on public.operators using (private.is_operator());
alter policy clients_rw on public.clients using (private.is_operator()) with check (private.is_operator());
alter policy streams_read on public.streams using (private.is_operator());
alter policy moments_read on public.moments using (private.is_operator());
alter policy clips_read on public.clips using (private.is_operator());
alter policy chat_read on public.chat_events using (private.is_operator());
alter policy signals_read on public.signal_samples using (private.is_operator());
alter policy cost_read on public.cost_events using (private.is_operator());
alter policy quota_read on public.quota_events using (private.is_operator());
alter policy actions_read on public.operator_actions using (private.is_operator());
alter policy actions_insert on public.operator_actions
  with check (private.is_operator() and processed_at is null and claimed_by is null);
alter policy deliveries_read on public.deliveries using (private.is_operator());

drop function public.is_operator();

create index if not exists clips_stream_idx on public.clips (stream_id);
create index if not exists deliveries_client_idx on public.deliveries (client_id);
create index if not exists operator_actions_clip_idx on public.operator_actions (clip_id);
create index if not exists operator_actions_moment_idx on public.operator_actions (moment_id);
