-- 03_sonar_providers.sql
-- Adds provider/model/key columns to agents, drops Beacon, ensures cascades.
-- Safe to run multiple times.

-- 1. Add columns for multi-provider Sonar
alter table public.agents add column if not exists provider text default 'openai_compat';
alter table public.agents add column if not exists api_key  text;
alter table public.agents add column if not exists base_url text;

-- 2. Make sure conversation deletes cascade to messages
--    (so admin deletes clean up properly)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'agent_messages_conversation_id_fkey'
  ) then
    -- fkey doesn't exist, skip
    null;
  else
    alter table public.agent_messages
      drop constraint agent_messages_conversation_id_fkey;
    alter table public.agent_messages
      add constraint agent_messages_conversation_id_fkey
      foreign key (conversation_id)
      references public.agent_conversations(id)
      on delete cascade;
  end if;
end $$;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'agent_tasks_conversation_id_fkey'
  ) then
    alter table public.agent_tasks
      drop constraint agent_tasks_conversation_id_fkey;
    alter table public.agent_tasks
      add constraint agent_tasks_conversation_id_fkey
      foreign key (conversation_id)
      references public.agent_conversations(id)
      on delete cascade;
  end if;
end $$;

-- 3. Remove Beacon completely
delete from public.agent_tasks         where agent_id = 'beacon';
delete from public.agent_messages      where conversation_id in (select id from public.agent_conversations where agent_id = 'beacon');
delete from public.agent_conversations where agent_id = 'beacon';
delete from public.agents              where id = 'beacon';

-- 4. Seed defaults for Sonar if not set
update public.agents
   set provider  = coalesce(provider, 'openai_compat'),
       base_url  = coalesce(base_url, 'https://api.groq.com/openai/v1'),
       model     = coalesce(model, 'openai/gpt-oss-120b')
 where id = 'sonar';
