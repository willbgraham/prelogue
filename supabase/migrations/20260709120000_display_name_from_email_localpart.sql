-- Actors signing up via email OTP had no name, so handle_new_user() defaulted
-- display_name to the FULL email — which then rendered publicly everywhere (a
-- privacy leak). Default to the email's local part instead ("nuzzih2@gmail.com"
-- → "nuzzih2"), and backfill anyone currently showing an email. Users can still
-- set a real display name in their profile.

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data->>'display_name', ''),
      split_part(new.email, '@', 1),
      ''
    )
  );
  return new;
end;
$$ language plpgsql security definer;

-- Backfill: strip the domain from any display_name that's currently an email.
-- (Real display names never contain '@'.)
update public.users
  set display_name = split_part(display_name, '@', 1)
  where display_name like '%@%';
