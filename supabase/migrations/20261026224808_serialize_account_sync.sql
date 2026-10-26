-- Serialize sync transactions per account before assigning revisions.
create or replace function public.sync_library(changes jsonb, after_revision bigint, expected_generation uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  owner uuid := auth.uid(); change jsonb; current_generation uuid; conflicts jsonb := '[]'::jsonb;
  changed integer; rows_out jsonb;
begin
  if owner is null then raise exception 'Authentication required'; end if;
  if jsonb_typeof(changes) <> 'array' or jsonb_array_length(changes)>200 then raise exception 'Invalid change batch'; end if;
  select generation into current_generation from public.vault_settings where user_id=owner for update;
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
