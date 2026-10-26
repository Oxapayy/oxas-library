-- All application operations run with the caller's JWT and RLS.
create table public.vault_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  generation uuid not null,
  salt text not null check (length(salt) between 16 and 128),
  wrapped_key text not null check (length(wrapped_key) between 32 and 2048),
  iterations integer not null check (iterations between 600000 and 2000000),
  updated_at timestamptz not null default now()
);
create sequence public.library_revision_seq;
create table public.library_records (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('source','progress','watchlist','preferences')),
  record_key text not null check (length(record_key) between 1 and 1024),
  payload jsonb not null check (octet_length(payload::text) <= 524288),
  deleted boolean not null default false,
  revision bigint not null default nextval('public.library_revision_seq'),
  updated_at timestamptz not null default now(),
  primary key(user_id,kind,record_key)
);
create index library_records_changes on public.library_records(user_id,revision);
alter table public.vault_settings enable row level security;
alter table public.library_records enable row level security;
revoke all on public.vault_settings, public.library_records from anon, authenticated;
grant select,insert,update,delete on public.vault_settings,public.library_records to authenticated;
grant usage on sequence public.library_revision_seq to authenticated;
create policy own_vault on public.vault_settings for all to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
create policy own_records on public.library_records for all to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);

-- Direct writes cannot choose a misleading revision/timestamp.
create function public.stamp_library_record() returns trigger language plpgsql security invoker set search_path='' as $$
begin
  new.revision := nextval('public.library_revision_seq');
  new.updated_at := now();
  return new;
end $$;
create trigger stamp_library_record before insert or update on public.library_records for each row execute function public.stamp_library_record();
revoke execute on function public.stamp_library_record() from public,anon,authenticated;

-- One server-revision compare-and-swap per record. Conflicts return current data;
-- an offline client never replaces an entire snapshot or resurrects tombstones.
create function public.sync_library(changes jsonb, after_revision bigint, expected_generation uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  owner uuid := auth.uid(); change jsonb; current_generation uuid; conflicts jsonb := '[]'::jsonb;
  changed integer; rows_out jsonb;
begin
  if owner is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(changes) <> 'array' or jsonb_array_length(changes)>200 then raise exception 'Invalid change batch'; end if;
  select generation into current_generation from public.vault_settings where user_id=owner for share;
  if current_generation is null or current_generation<>expected_generation then raise exception 'Vault generation changed. Sign in again.'; end if;
  for change in select value from jsonb_array_elements(changes) loop
    if length(change->>'key') not between 1 and 1024 or change->>'kind' not in ('source','progress','watchlist','preferences') then raise exception 'Invalid change'; end if;
    insert into public.library_records as target(user_id,kind,record_key,payload,deleted)
    select owner,change->>'kind',change->>'key',change->'payload',coalesce((change->>'deleted')::boolean,false)
    where coalesce((change->>'base_revision')::bigint,0)=0
    on conflict(user_id,kind,record_key) do nothing;
    get diagnostics changed = row_count;
    if changed=0 then
      update public.library_records set payload=change->'payload',deleted=coalesce((change->>'deleted')::boolean,false)
      where user_id=owner and kind=change->>'kind' and record_key=change->>'key' and revision=(change->>'base_revision')::bigint;
      get diagnostics changed=row_count;
    end if;
    if changed=0 then conflicts := conflicts || jsonb_build_array(jsonb_build_object('kind',change->>'kind','key',change->>'key')); end if;
  end loop;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.revision),'[]'::jsonb) into rows_out from (
    select kind,record_key as key,payload,deleted,revision,updated_at from public.library_records
    where user_id=owner and revision>greatest(after_revision,0) order by revision limit 1000
  ) r;
  return jsonb_build_object('records',rows_out,'conflicts',conflicts,'generation',current_generation);
end $$;
revoke all on function public.sync_library(jsonb,bigint,uuid) from public,anon;
grant execute on function public.sync_library(jsonb,bigint,uuid) to authenticated;

-- Recovery explicitly discards old encrypted connection records, retaining media state.
create function public.reset_connection_vault(new_generation uuid,new_salt text,new_wrapped_key text,new_iterations integer)
returns void language plpgsql security invoker set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  update public.vault_settings set generation=new_generation,salt=new_salt,wrapped_key=new_wrapped_key,iterations=new_iterations,updated_at=now() where user_id=auth.uid();
  if not found then
    insert into public.vault_settings(user_id,generation,salt,wrapped_key,iterations) values(auth.uid(),new_generation,new_salt,new_wrapped_key,new_iterations);
  end if;
  update public.library_records set deleted=true,payload='{}'::jsonb where user_id=auth.uid() and kind='source';
end $$;
revoke all on function public.reset_connection_vault(uuid,text,text,integer) from public,anon;
grant execute on function public.reset_connection_vault(uuid,text,text,integer) to authenticated;
