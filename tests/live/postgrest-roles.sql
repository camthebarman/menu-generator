-- PostgREST connects as `authenticator` and switches to anon/authenticated per request, as Supabase does.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login password 'authenticator' noinherit;
  end if;
end $$;
grant anon, authenticated to authenticator;
