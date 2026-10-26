-- Public non-secret feature readiness; only project operators can change this row.
create table public.app_configuration (
  id boolean primary key default true check(id),
  auth_emails_ready boolean not null default false
);
insert into public.app_configuration(id,auth_emails_ready) values(true,false);
alter table public.app_configuration enable row level security;
revoke all on public.app_configuration from anon,authenticated;
grant select on public.app_configuration to anon,authenticated;
create policy read_configuration on public.app_configuration for select to anon,authenticated using(true);
