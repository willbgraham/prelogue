-- Writer monetization: gate full AI-voice generation behind a paid plan.
--
-- A writer's script is "voice-unlocked" when the writer's plan is active or in
-- a Stripe trial. Free writers get a short preview (the opening of the script)
-- so they hear the magic, then upgrade to voice the whole thing.

alter table public.users add column if not exists plan text not null default 'free';
alter table public.users add column if not exists plan_status text;            -- stripe sub status: active|trialing|past_due|canceled|...
alter table public.users add column if not exists stripe_customer_id text;
alter table public.users add column if not exists stripe_subscription_id text;
alter table public.users add column if not exists plan_renews_at timestamptz;

-- Grandfather everyone who already exists (pre-launch) to pro so current flows
-- don't suddenly hit the paywall. New signups default to 'free'.
update public.users set plan = 'pro', plan_status = 'active' where plan = 'free';

create index if not exists users_stripe_customer_idx on public.users (stripe_customer_id);

-- Clients must NOT be able to grant themselves a plan. Only the service role
-- (the Stripe webhook) may change the billing columns; any other writer is
-- silently reverted to the prior values.
create or replace function public.protect_plan_columns()
returns trigger
language plpgsql
security definer
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    new.plan := old.plan;
    new.plan_status := old.plan_status;
    new.stripe_customer_id := old.stripe_customer_id;
    new.stripe_subscription_id := old.stripe_subscription_id;
    new.plan_renews_at := old.plan_renews_at;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_plan_columns_trg on public.users;
create trigger protect_plan_columns_trg
  before update on public.users
  for each row execute function public.protect_plan_columns();
