-- Multi-tenant SaaS: orgs own everything, users join orgs through members with a role.
-- Stripe is the source of truth for billing; the webhook (service role, bypasses RLS) mirrors it here.

create type member_role as enum ('owner', 'admin', 'member');

create table orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  stripe_customer_id text unique,
  created_at timestamptz not null default now()
);

create table members (
  org_id uuid not null references orgs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role member_role not null default 'member',
  primary key (org_id, user_id)
);

create table subscriptions (
  org_id uuid primary key references orgs (id) on delete cascade,
  stripe_subscription_id text not null unique,
  status text not null, -- trialing | active | past_due | canceled | ...
  price_id text not null,
  current_period_end timestamptz,
  stripe_event_created timestamptz not null -- newest Stripe event applied; older ones are ignored
);

create table stripe_events (
  id text primary key, -- Stripe event id = idempotency key
  type text not null,
  received_at timestamptz not null default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs (id) on delete cascade,
  name text not null
);

-- Role of the signed-in user in an org (null = not a member).
-- security definer so policies on members can call it without recursing into members' own RLS.
create function org_role(o uuid) returns member_role
language sql stable security definer set search_path = public as
$$ select role from members where org_id = o and user_id = auth.uid() $$;

create function org_has_plan(o uuid) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from subscriptions where org_id = o and status in ('trialing', 'active')) $$;

-- Signing up: any user can create an org and becomes its owner.
create function create_org(org_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into orgs (name) values (org_name) returning id into new_id;
  insert into members (org_id, user_id, role) values (new_id, auth.uid(), 'owner');
  return new_id;
end $$;

alter table orgs enable row level security;
alter table members enable row level security;
alter table subscriptions enable row level security;
alter table stripe_events enable row level security; -- no policies: only the service role touches it
alter table projects enable row level security;

create policy orgs_read on orgs for select using (org_role(id) is not null);
create policy orgs_rename on orgs for update using (org_role(id) in ('owner', 'admin'));

create policy members_read on members for select using (org_role(org_id) is not null);
-- owners/admins invite; nobody can hand out 'owner' through an insert
create policy members_add on members for insert
  with check (org_role(org_id) in ('owner', 'admin') and role <> 'owner');
-- only the owner changes roles
create policy members_change_role on members for update
  using (org_role(org_id) = 'owner') with check (org_role(org_id) = 'owner');
-- owners/admins remove people, but the owner row cannot be removed
create policy members_remove on members for delete
  using (org_role(org_id) in ('owner', 'admin') and role <> 'owner');

create policy subscriptions_read on subscriptions for select using (org_role(org_id) is not null);

create policy projects_read on projects for select using (org_role(org_id) is not null);
-- billing gate in the database: creating a project needs a trialing/active subscription
create policy projects_create on projects for insert
  with check (org_role(org_id) is not null and org_has_plan(org_id));
create policy projects_edit on projects for update using (org_role(org_id) is not null);
create policy projects_delete on projects for delete using (org_role(org_id) in ('owner', 'admin'));

grant select, update on orgs to authenticated;
grant select, insert, update, delete on members to authenticated;
grant select on subscriptions to authenticated;
grant select, insert, update, delete on projects to authenticated;
grant execute on function create_org(text) to authenticated;
