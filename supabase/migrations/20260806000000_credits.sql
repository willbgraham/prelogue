-- Credits: the single meter for AI voice generation.
--
-- 1 credit = 1,000 characters of generated speech (~8.2c of ElevenLabs at our
-- plan rate). Real scripts: a 10-page short ≈ 7 credits, a 33-page script ≈ 32,
-- a 105-page feature ≈ 88.
--
-- Why: unlocks were metered, but REGENERATION wasn't — re-casting a feature
-- costs as much as the first pass, and nothing capped it. A writer changing
-- voices all day could run up unbounded cost against a $19 subscription.
-- Metering generation itself bounds worst-case COGS below revenue on every
-- plan, so no usage pattern can produce a loss.

alter table public.users
  add column if not exists credits_balance int not null default 0;
alter table public.users
  add column if not exists credits_granted_at timestamptz;
-- Single-line previews are ~150 chars — far less than a credit. Accumulate
-- their characters here and only debit a credit per full 1,000, so auditioning
-- voices on one line isn't charged at 6x its real cost.
alter table public.users
  add column if not exists credits_preview_chars int not null default 0;

-- Audit trail: every grant and every spend, so balances are explainable.
create table if not exists public.credit_ledger (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  delta      int not null,             -- + granted, - spent
  reason     text not null,            -- plan_grant | topup | unlock_grant | generation | preview | admin
  ref        text,                     -- script id, stripe session, etc.
  balance_after int not null,
  created_at timestamptz not null default now()
);
create index if not exists credit_ledger_user_idx
  on public.credit_ledger (user_id, created_at desc);

alter table public.credit_ledger enable row level security;

drop policy if exists "users read own ledger" on public.credit_ledger;
create policy "users read own ledger" on public.credit_ledger
  for select to authenticated
  using (user_id = auth.uid());
-- No insert/update/delete policy: only the service role (edge functions) writes.

-- Balances must never be client-writable. Fold into the existing guard that
-- already protects plan/billing columns.
create or replace function public.protect_plan_columns()
returns trigger
language plpgsql
security definer
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    new.plan := old.plan;
    new.plan_status := old.plan_status;
    new.stripe_customer_id := old.stripe_customer_id;
    new.stripe_subscription_id := old.stripe_subscription_id;
    new.plan_renews_at := old.plan_renews_at;
    new.plan_pages_used := old.plan_pages_used;
    new.is_admin := old.is_admin;
    new.credits_balance := old.credits_balance;
    new.credits_granted_at := old.credits_granted_at;
    new.credits_preview_chars := old.credits_preview_chars;
  end if;
  return new;
end;
$$;

-- Atomic debit. Returns the new balance, or -1 when there aren't enough
-- credits (the UPDATE simply matches no row, so concurrent generations can't
-- race the balance negative).
create or replace function public.spend_credits(
  p_user uuid, p_credits int, p_reason text, p_ref text default null
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare new_balance int;
begin
  if p_credits <= 0 then
    select credits_balance into new_balance from public.users where id = p_user;
    return coalesce(new_balance, 0);
  end if;

  update public.users
     set credits_balance = credits_balance - p_credits
   where id = p_user and credits_balance >= p_credits
   returning credits_balance into new_balance;

  if new_balance is null then
    return -1;                      -- insufficient credits
  end if;

  insert into public.credit_ledger (user_id, delta, reason, ref, balance_after)
  values (p_user, -p_credits, p_reason, p_ref, new_balance);
  return new_balance;
end;
$$;

-- Grant credits (plan renewal, top-up purchase, one-time unlock, admin gift).
-- p_set_to_at_least: for monthly plan grants — tops the balance UP to the plan
-- allowance rather than stacking month on month, so an idle month doesn't
-- accumulate an unbounded liability.
create or replace function public.grant_credits(
  p_user uuid, p_credits int, p_reason text, p_ref text default null,
  p_set_to_at_least boolean default false
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare new_balance int; delta int;
begin
  if p_set_to_at_least then
    select greatest(0, p_credits - credits_balance) into delta
      from public.users where id = p_user;
  else
    delta := p_credits;
  end if;
  if delta is null then return 0; end if;

  update public.users
     set credits_balance = credits_balance + delta,
         credits_granted_at = now()
   where id = p_user
   returning credits_balance into new_balance;

  if new_balance is null then return 0; end if;

  if delta <> 0 then
    insert into public.credit_ledger (user_id, delta, reason, ref, balance_after)
    values (p_user, delta, p_reason, p_ref, new_balance);
  end if;
  return new_balance;
end;
$$;

revoke all on function public.spend_credits(uuid, int, text, text) from public, anon, authenticated;
revoke all on function public.grant_credits(uuid, int, text, text, boolean) from public, anon, authenticated;
grant execute on function public.spend_credits(uuid, int, text, text) to service_role;
grant execute on function public.grant_credits(uuid, int, text, text, boolean) to service_role;

-- Seed existing subscribers so nobody is stranded mid-period.
update public.users
   set credits_balance = greatest(credits_balance,
         case plan when 'growth' then 100 when 'pro' then 225 when 'studio' then 375 else 0 end),
       credits_granted_at = coalesce(credits_granted_at, now())
 where plan_status in ('active', 'trialing');
