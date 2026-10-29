-- Mr Priceless CRM - Ad production (AI ad creative jobs), phase 1: copy only.
-- Someone fills in a brief for a client; the creative-agent Edge Function
-- has Claude draft ad angles, waits for a person to tick the ones to run
-- (the angle check, on by default), then writes the copy for each concept.
-- A person approves or rejects each one with a note.
--
-- The work is a queue of steps (creative_steps), one row per pipeline
-- stage, picked up by the function every minute (pg_cron below) and straight
-- away when the page asks. Each step saves its result before the next one
-- is queued, so a failure retries only that step (3 tries, waiting longer
-- each time). Versions are never overwritten: a redo adds a new row.
-- Every API call is logged in creative_usage and added to the job's cost;
-- a job that reaches its cost limit pauses and says why.
-- Run after 100. Safe to re-run.

-- Brand details reused on every job for a client (one row per client).
create table if not exists client_brand (
  client_id uuid primary key references clients(id) on delete cascade,
  voice text,
  colours text,
  logo_url text,
  reference_image_urls jsonb not null default '[]'::jsonb,
  do_not_say text,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- The agency playbook given to every Claude call. Versioned; one is active.
create table if not exists creative_playbook_versions (
  id uuid primary key default gen_random_uuid(),
  version_no integer not null unique,
  content text not null,
  change_summary text,
  approved_by text,
  active boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists creative_playbook_one_active on creative_playbook_versions (active) where active;

insert into creative_playbook_versions (version_no, content, change_summary, approved_by, active)
select 1, $pb$# Mr Priceless ad playbook (v1 - placeholder until we write our own)

Who we write for
- Local trades and service businesses in New Zealand and Australia: plumbers, electricians, builders, roofers, landscapers, HVAC and the like.
- The people seeing the ads are homeowners (sometimes property managers or small businesses) scrolling Facebook or Instagram, or searching Google with a job in mind.

What the ads are for
- Direct response: get a local person to send an enquiry, book a quote or call. Not brand awareness.
- One ad, one job, one idea. Talk about the specific job the client wants more of, in the area they want it.

How we write
- Plain-spoken New Zealand English (NZ spelling: colour, organise, metre). Sound like a good local tradie talking, not an agency.
- Specific beats vague. "Hot water back on the same day in West Auckland" beats "fast, reliable service". Use real numbers, places and timeframes where the brief gives them.
- Lead with the problem or the outcome the customer cares about, in the first line. The first 125 characters must work on their own.
- Benefits over features, and proof over claims: years in business, reviews, guarantees, licensed, local.
- Short sentences. No jargon, no hype words ("amazing", "best in the business", "cutting-edge"), no ALL CAPS, at most one emoji and only if it fits the brand.
- Never invent facts about the client (prices, guarantees, awards, years, review counts). Only use what's in the brief or the brand details. If an offer isn't given, don't make one up.
- End with one clear call to action that matches what we want them to do (get a quote, book, call).

Ad platform rules
- Meta: no "you" statements that imply personal attributes (health, finances, etc.), no before/after claims that overpromise, no fake urgency.
- Google: match the words people search; put the job and the area in the headline.
$pb$, 'Placeholder v1: the basics until the real playbook is drafted from our past work.', 'setup', true
where not exists (select 1 from creative_playbook_versions);

-- One brief = one job.
create table if not exists creative_jobs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  target_jobs text not null,
  offer text,
  platform text not null default 'meta' check (platform in ('meta', 'google', 'other')),
  location text,
  concept_count integer not null default 4 check (concept_count between 1 and 10),
  angle_check_enabled boolean not null default true,
  notes text,
  angle_note text,                 -- the one note from the angle check
  status text not null default 'drafting_angles'
    check (status in ('drafting_angles', 'awaiting_angle_check', 'generating', 'in_review', 'revising', 'approved', 'failed', 'paused')),
  error text,                      -- why it failed or paused
  cost_usd numeric(12, 6) not null default 0,
  cost_ceiling_usd numeric(10, 2) not null default 10,
  playbook_version integer,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists creative_jobs_client_idx on creative_jobs (client_id);
create index if not exists creative_jobs_created_idx on creative_jobs (created_at desc);

create table if not exists creative_angles (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references creative_jobs(id) on delete cascade,
  position integer not null,
  name text not null,
  rationale text,
  hook_options jsonb not null default '[]'::jsonb,
  selected boolean not null default false,
  prompt_template_version text,
  created_at timestamptz not null default now(),
  unique (job_id, position)
);

-- A concept is one ad slot in the job, under one angle. Its drafts are
-- creative_versions; a redo adds a new version, never edits an old one.
create table if not exists creative_concepts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references creative_jobs(id) on delete cascade,
  angle_id uuid not null references creative_angles(id) on delete cascade,
  concept_no integer not null,
  hook_index integer not null default 0,   -- which of the angle's hooks it leads with
  status text not null default 'drafting'
    check (status in ('drafting', 'in_review', 'approved', 'rejected', 'revising', 'discarded')),
  created_at timestamptz not null default now(),
  unique (job_id, concept_no)
);
create index if not exists creative_concepts_job_idx on creative_concepts (job_id);

create table if not exists creative_versions (
  id uuid primary key default gen_random_uuid(),
  concept_id uuid not null references creative_concepts(id) on delete cascade,
  angle_id uuid not null references creative_angles(id) on delete cascade,
  version_no integer not null,
  primary_text text,
  headline text,
  cta text,
  hook_variants jsonb not null default '[]'::jsonb,
  image_prompt text,               -- phase 2
  image_url text,                  -- phase 2
  qa_result jsonb,                 -- phase 2
  prompt_template_version text,
  status text not null default 'in_review'
    check (status in ('in_review', 'approved', 'rejected', 'superseded', 'discarded')),
  created_at timestamptz not null default now(),
  unique (concept_id, version_no)
);
create index if not exists creative_versions_concept_idx on creative_versions (concept_id);

create table if not exists creative_reviews (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references creative_versions(id) on delete cascade,
  reviewer_email text,
  decision text not null check (decision in ('approve', 'reject', 'discard')),
  redo text check (redo in ('copy', 'image', 'both')),
  note text,
  created_at timestamptz not null default now(),
  check (decision <> 'reject' or (coalesce(btrim(note), '') <> '' and redo is not null))
);
create index if not exists creative_reviews_version_idx on creative_reviews (version_id);

-- The queue: one row per pipeline step. kind 'angles' (one per job) or
-- 'copy' (one per concept). The unique key makes queuing a step twice a no-op.
create table if not exists creative_steps (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references creative_jobs(id) on delete cascade,
  kind text not null check (kind in ('angles', 'copy', 'image_prompt', 'image', 'self_check', 'revision')),
  concept_id uuid references creative_concepts(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts integer not null default 0,
  run_after timestamptz not null default now(),
  locked_until timestamptz,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists creative_steps_once on creative_steps (job_id, kind, coalesce(concept_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists creative_steps_due_idx on creative_steps (status, run_after);

-- Every API call: tokens, images and what it cost.
create table if not exists creative_usage (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references creative_jobs(id) on delete cascade,
  step_id uuid references creative_steps(id) on delete set null,
  step_kind text,
  provider text not null default 'anthropic',
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  image_count integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists creative_usage_job_idx on creative_usage (job_id);

-- A new job queues its first step.
create or replace function public.creative_job_queue_angles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into creative_steps (job_id, kind) values (new.id, 'angles') on conflict do nothing;
  return new;
end $$;
drop trigger if exists creative_jobs_queue_angles on creative_jobs;
create trigger creative_jobs_queue_angles after insert on creative_jobs
  for each row execute function public.creative_job_queue_angles();

-- Hand out up to n due steps to one worker run. A step whose run died
-- (still 'running' after its lock ran out) counts as due again.
create or replace function public.creative_claim_steps(n integer default 4)
returns setof creative_steps
language sql
security definer
set search_path = public
as $$
  update creative_steps s
     set status = 'running', attempts = s.attempts + 1, locked_until = now() + interval '5 minutes'
   where s.id in (
     select c.id from creative_steps c
      join creative_jobs j on j.id = c.job_id
      where j.status not in ('failed', 'paused')
        and ((c.status = 'queued' and c.run_after <= now())
          or (c.status = 'running' and c.locked_until < now()))
      order by c.run_after
      limit greatest(1, least(n, 10))
      for update of c skip locked
   )
  returning s.*;
$$;

-- Add a call's cost to its job in one go (two steps can finish at once).
create or replace function public.creative_add_cost(p_job uuid, p_cost numeric)
returns numeric
language sql
security definer
set search_path = public
as $$
  update creative_jobs set cost_usd = cost_usd + coalesce(p_cost, 0), updated_at = now()
   where id = p_job
  returning cost_usd;
$$;

revoke all on function public.creative_claim_steps(integer) from public, anon, authenticated;
revoke all on function public.creative_add_cost(uuid, numeric) from public, anon, authenticated;
grant execute on function public.creative_claim_steps(integer) to service_role;
grant execute on function public.creative_add_cost(uuid, numeric) to service_role;

-- Team only, like everything else (sql/066). Lead Follow Up only logins
-- don't pass is_allowlisted(), so they see none of this.
do $$
declare p record; t text;
begin
  foreach t in array array['client_brand', 'creative_playbook_versions', 'creative_jobs', 'creative_angles', 'creative_concepts', 'creative_versions', 'creative_reviews', 'creative_steps', 'creative_usage'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy "team only" on public.%I for all using (public.is_allowlisted()) with check (public.is_allowlisted())', t);
  end loop;
end $$;

-- Live updates, so the page moves on by itself as the steps finish.
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then return; end if;
  foreach t in array array['creative_jobs', 'creative_angles', 'creative_concepts', 'creative_versions', 'creative_reviews'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Only the schedule below can ask the function to work the queue.
insert into app_secrets (name, value)
values ('creative_cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('creative-agent')
where exists (select 1 from cron.job where jobname = 'creative-agent');

select cron.schedule(
  'creative-agent',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://chaexdenosljtdwuyjnw.supabase.co/functions/v1/creative-agent',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_2FnHNV8THv1QUrFumCzu4A_WyCD9UH_',
      'x-cron-secret', (select value from public.app_secrets where name = 'creative_cron_secret')
    ),
    body := '{}'::jsonb
  )
  where exists (
    select 1 from public.creative_steps s
      join public.creative_jobs j on j.id = s.job_id
     where j.status not in ('failed', 'paused')
       and ((s.status = 'queued' and s.run_after <= now()) or (s.status = 'running' and s.locked_until < now()))
  );
  $$
);
