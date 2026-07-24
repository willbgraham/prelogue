-- Subscription pricing: pages-per-month plans (Growth / Pro / Studio) that unlock
-- scripts from a monthly page budget, alongside the existing $19 one-time
-- per-script unlock (20260618100000_per_script_unlock.sql).
--
-- SELF-CONTAINED on purpose: the earlier writer-plan migration
-- (20260613000000_add_writer_plan.sql) was never applied to this project — only
-- stripe_customer_id exists (added by the per-script-unlock migration). So this
-- file adds ALL the plan/billing columns and the protect trigger itself,
-- idempotently, rather than assuming they're already there.
--
-- Metering model: a subscriber "spends" a script's page_count when they unlock
-- its full read; the unlock is PERMANENT (exactly like the one-time purchase).
-- The monthly budget (plan_pages_used) resets each Stripe billing period, driven
-- by the stripe-webhook (invoice.paid). See:
--   supabase/functions/create-checkout-session  (subscription checkout)
--   supabase/functions/stripe-webhook           (lifecycle + budget reset)
--   supabase/functions/subscription-unlock       (metered per-script unlock)

-- 1. Plan / billing columns on the writer (all idempotent).
alter table public.users add column if not exists plan text not null default 'free';
alter table public.users add column if not exists plan_status text;               -- stripe sub status: active|trialing|past_due|canceled|...
alter table public.users add column if not exists stripe_customer_id text;
alter table public.users add column if not exists stripe_subscription_id text;
alter table public.users add column if not exists plan_renews_at timestamptz;      -- current period end
alter table public.users add column if not exists plan_pages_used int not null default 0;

create index if not exists users_stripe_customer_idx on public.users (stripe_customer_id);

-- 2. Any grandfathered non-subscriber goes to free. This is a no-op when the
--    plan column was just created with default 'free', but stays correct if an
--    earlier partial run had set some rows to 'pro'.
update public.users
  set plan = 'free', plan_status = null, plan_pages_used = 0
  where stripe_subscription_id is null
    and plan is distinct from 'free';

-- 3. Protect the billing columns (incl. the usage meter) so a writer can neither
--    grant themselves a plan NOR zero out their own page usage. Only the service
--    role (Stripe webhook + subscription-unlock fn) may write these.
create or replace function public.protect_plan_columns()
returns trigger
language plpgsql
security definer
as $$
begin
  -- auth.jwt()->>'role' is 'service_role' for the service-role key, 'authenticated'
  -- for a signed-in user, 'anon' otherwise. (auth.role() is deprecated / may be
  -- absent; auth.jwt() is the same helper can_view_script already relies on.)
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    new.plan := old.plan;
    new.plan_status := old.plan_status;
    new.stripe_customer_id := old.stripe_customer_id;
    new.stripe_subscription_id := old.stripe_subscription_id;
    new.plan_renews_at := old.plan_renews_at;
    new.plan_pages_used := old.plan_pages_used;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_plan_columns_trg on public.users;
create trigger protect_plan_columns_trg
  before update on public.users
  for each row execute function public.protect_plan_columns();

-- 4. CRITICAL — close the paywall hole. "Writers can update own scripts" (initial
--    schema) has NO column scope, so a writer could set full_read_unlocked=true
--    themselves via the API and bypass BOTH the $19 charge and the plan budget.
--    Revert the entitlement columns on any non-service-role write (and force
--    them false on insert). The webhook, the daily-render worker, and the
--    subscription-unlock fn all use the service role, so legitimate unlocks pass.
create or replace function public.protect_script_entitlement()
returns trigger
language plpgsql
security definer
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    if tg_op = 'INSERT' then
      new.full_read_unlocked := false;
      new.unlocked_at := null;
    else
      new.full_read_unlocked := old.full_read_unlocked;
      new.unlocked_at := old.unlocked_at;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_script_entitlement_trg on public.scripts;
create trigger protect_script_entitlement_trg
  before insert or update on public.scripts
  for each row execute function public.protect_script_entitlement();
