-- =====================================================================
-- UN Women Challenge: Gendered Disinformation Detector
-- FILE 1 of 3: schema (tables, rules, security, helper functions)
--
-- How to run: Supabase Dashboard > SQL Editor > New query >
-- paste this whole file > Run. Then run 02_reference_data.sql,
-- then 03_demo_seed.sql.
--
-- Design rules:
--   * The FastAPI backend talks to the database with the service_role
--     key (it skips the security rules). That key lives ONLY on the server.
--   * The website/extension only ever get the anon key. With the anon key,
--     the security rules below decide what anyone can see.
--   * Nothing reaches the extension unless a verified organisation approved it.
-- =====================================================================


-- =====================================================================
-- PART A. LOOKUP TABLES (the "contract" the whole team codes against)
-- =====================================================================

create table countries (
  code char(2) primary key,          -- ISO 3166, e.g. 'PH'
  name text not null
);

create table languages (
  code text primary key,             -- ISO 639-1, e.g. 'tl'
  name text not null
);

-- The 4 categories from the team's category guide
create table categories (
  code        text primary key,      -- e.g. 'gender_hate_speech'
  name        text not null,         -- shown in the pop-up
  description text not null,
  key_test    text not null,         -- the one-line question from the guide
  sort_order  smallint not null
);

create table subtypes (
  category_code text not null references categories on update cascade,
  code          text not null,       -- e.g. 'sexist_insult'
  name          text not null,
  sort_order    smallint not null,
  primary key (category_code, code)
);


-- =====================================================================
-- PART B. PEOPLE AND ORGANISATIONS
-- =====================================================================

create table organizations (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  country_code char(2) references countries,
  org_type     text not null default 'ngo'
               check (org_type in ('ngo', 'un_women_office', 'community_group', 'government', 'other')),
  is_verified  boolean not null default false,   -- only verified orgs can approve lexicon entries
  verified_at  timestamptz,
  contact_email text,
  created_at   timestamptz not null default now()
);

-- One row per logged-in user (created automatically at sign-up, see below)
create table profiles (
  id              uuid primary key references auth.users on delete cascade,
  display_name    text,
  role            text not null default 'community'
                  check (role in ('community', 'org_member', 'leader', 'admin')),
  organization_id uuid references organizations on delete set null,
  country_code    char(2) references countries,
  created_at      timestamptz not null default now()
);


-- =====================================================================
-- PART C. THE LEXICON (core dataset served to the extension)
-- =====================================================================

create table lexicon_entries (
  id             uuid primary key default gen_random_uuid(),
  term           text not null,
  variants       text[] not null default '{}',   -- misspellings, transliterations, emoji swaps
  entry_type     text not null default 'term'
                 check (entry_type in ('term', 'phrase', 'hashtag', 'emoji_code',
                                       'coded_expression', 'stereotype', 'narrative')),
  language_code  text not null references languages,
  country_code   char(2) references countries,   -- null = used across the region
  meaning        text,                            -- plain explanation
  category_code  text not null references categories,
  subtype_code   text,
  severity       text not null default 'medium' check (severity in ('low', 'medium', 'high')),
  is_urgent      boolean not null default false,  -- threats / doxxing -> urgent steps in the pop-up
  context_note   text,                            -- when it is (and isn't) harmful
  status         text not null default 'pending'
                 check (status in ('pending', 'approved', 'rejected', 'retired')),
  source         text not null default 'community'
                 check (source in ('community', 'partner_org', 'seed_demo', 'imported')),
  raw_submission text,                            -- what the community member actually wrote
  ai_draft       jsonb,                           -- the AI's structured draft, before a human edits it
  reviewer_note  text,
  submitted_by   uuid references profiles on delete set null,
  approved_by    uuid references profiles on delete set null,
  approved_by_org uuid references organizations,
  approved_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  foreign key (category_code, subtype_code) references subtypes (category_code, code),
  constraint approved_needs_org check (status <> 'approved' or approved_by_org is not null),
  constraint no_blank_variants  check (array_position(variants, '') is null)
);
-- Same term can't be added twice for the same language + country
create unique index lexicon_unique_term
  on lexicon_entries (lower(term), language_code, coalesce(country_code, '--'));
create index lexicon_lookup on lexicon_entries (status, country_code, language_code);

-- Every change to the lexicon is logged (defence against lexicon poisoning:
-- you can always see who changed or removed an entry, and undo it)
create table lexicon_audit (
  id         bigint generated always as identity primary key,
  entry_id   uuid not null,          -- no foreign key, so history survives deletes
  action     text not null check (action in ('insert', 'update', 'delete')),
  changed_by uuid,                   -- logged-in user, or null if the backend made the change
  old_row    jsonb,
  new_row    jsonb,
  changed_at timestamptz not null default now()
);
create index lexicon_audit_entry on lexicon_audit (entry_id, changed_at);


-- =====================================================================
-- PART D. POP-UP CONTENT (legal info, platform links, next steps)
-- =====================================================================

create table legal_info (
  country_code    char(2) primary key references countries,
  law_name        text not null,
  law_url         text,
  what_it_covers  text not null,
  where_to_report text not null,
  report_url      text,
  helpline        text,
  disclaimer      text not null default
    'This is general legal information, not legal advice. Laws and reporting channels change; check with a local lawyer or support organisation.',
  updated_at      timestamptz not null default now()
);

create table platform_reporting (
  platform      text primary key,    -- matches reports.platform
  display_name  text not null,
  how_to_report text not null,
  link_label    text,
  report_url    text
);

-- "What to do next" steps. guidance_key is 'urgent' or a category code.
-- audience lets the wording change for the target / an ally / org staff.
create table next_steps (
  guidance_key text not null,
  audience     text not null check (audience in ('target', 'ally', 'org', 'any')),
  steps        text[] not null,
  primary key (guidance_key, audience)
);


-- =====================================================================
-- PART E. LEADERS AND EVENTS (private: never sent to the extension)
-- =====================================================================

create table leaders (
  id              uuid primary key default gen_random_uuid(),
  full_name       text not null,
  name_variants   text[] not null default '{}',  -- titles, nicknames, hashtags used for her
  public_role     text,
  country_code    char(2) not null references countries,
  organization_id uuid references organizations on delete set null,  -- her designated support org
  profile_id      uuid unique references profiles on delete set null, -- her own account, if any
  alerts_opt_in   boolean not null default true,
  created_at      timestamptz not null default now()
);

create table events (
  id           uuid primary key default gen_random_uuid(),
  leader_id    uuid not null references leaders on delete cascade,
  name         text not null,
  event_type   text not null default 'other'
               check (event_type in ('rally', 'speech', 'debate', 'election', 'interview', 'other')),
  starts_at    timestamptz not null,
  ends_at      timestamptz,
  city         text,              -- city only. Never store the exact venue or address.
  alert_emails text[] not null default '{}',
  created_at   timestamptz not null default now()
);
create index events_leader_time on events (leader_id, starts_at);


-- =====================================================================
-- PART F. REPORTS (sent by the extension via the backend)
-- =====================================================================

create table reports (
  id                uuid primary key default gen_random_uuid(),
  url               text not null,
  url_key           text generated always as
                    (lower(regexp_replace(url, '(#.*$)|(/+$)', '', 'g'))) stored,  -- for duplicate detection
  platform          text not null default 'other'
                    check (platform in ('facebook', 'instagram', 'x', 'tiktok', 'youtube', 'news_site', 'other')),
  flagged_text      text,         -- only the flagged sentence, never the whole page
  matched_entry_id  uuid references lexicon_entries on delete set null,
  matched_text      text,
  category_code     text references categories,
  subtype_code      text,
  is_urgent         boolean not null default false,
  classification    jsonb,        -- full AI output: gender_component, factual_claim,
                                  -- manipulation_detected, verification_needed, explanation
  language_code     text references languages,
  country_code      char(2) references countries,
  leader_id         uuid references leaders on delete set null,
  event_id          uuid references events on delete set null,
  screenshot_path   text,         -- path inside the 'report-screenshots' storage bucket
  screenshot_sha256 char(64) check (screenshot_sha256 ~ '^[0-9a-f]{64}$'),
  reporter_role     text not null check (reporter_role in ('target', 'ally', 'organization')),
  reporter_id       uuid references profiles on delete set null,     -- only if logged in
  reporter_org_id   uuid references organizations on delete set null,
  duplicate_of      uuid references reports on delete set null,      -- filled automatically
  review_status     text not null default 'new' check (review_status in ('new', 'confirmed', 'dismissed')),
  is_demo           boolean not null default false,                  -- injected by the demo button
  reported_at       timestamptz not null default now(),
  foreign key (category_code, subtype_code) references subtypes (category_code, code)
);
create index reports_leader_time on reports (leader_id, reported_at) where duplicate_of is null;
create index reports_url_key     on reports (url_key, reported_at);
create index reports_time        on reports (reported_at);


-- =====================================================================
-- PART G. ALERTS AND INCIDENTS
-- =====================================================================

create table alerts (
  id                uuid primary key default gen_random_uuid(),
  leader_id         uuid not null references leaders on delete cascade,
  event_id          uuid references events on delete set null,   -- nearest upcoming event, if any
  triggered_at      timestamptz not null default now(),
  reports_last_24h  int not null,
  daily_avg_prev_7d numeric(8,2) not null,
  ratio             numeric(8,2),                -- null when there was no baseline
  top_categories    jsonb,                       -- e.g. {"gendered_disinformation": 12}
  ai_summary        text,                        -- filled in by the backend (AI summary)
  seen_at           timestamptz,
  seen_by           uuid references profiles on delete set null,
  is_demo           boolean not null default false
);
create index alerts_leader_time on alerts (leader_id, triggered_at);

create table incidents (
  id          uuid primary key default gen_random_uuid(),
  leader_id   uuid not null references leaders on delete cascade,
  event_id    uuid references events on delete set null,
  recorded_by uuid references profiles on delete set null,
  title       text not null,
  description text,
  occurred_at timestamptz,
  witnesses   text,              -- keep contact details to the minimum needed
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Evidence files. Rows can never be edited once saved (see trigger below),
-- so the hash + timestamp prove the file was not changed later.
create table incident_files (
  id          uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents on delete cascade,
  file_path   text not null unique,     -- path inside the 'incident-files' storage bucket
  file_kind   text not null check (file_kind in ('photo', 'voice_note', 'screenshot', 'document', 'video')),
  mime_type   text,
  size_bytes  bigint check (size_bytes >= 0),
  sha256      char(64) not null check (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by uuid references profiles on delete set null,
  uploaded_at timestamptz not null default now()
);


-- =====================================================================
-- PART H. TRIGGERS (rules the database enforces by itself)
-- =====================================================================

-- H1. New sign-up -> create a profile row automatically
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- H2. Keep updated_at current
create or replace function public.touch_updated_at()
returns trigger language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger incidents_touch before update on incidents
  for each row execute function public.touch_updated_at();

-- H3. Lexicon rules: tidy variants, stamp approval time,
--     and refuse approvals from organisations that aren't verified
create or replace function public.lexicon_before_write()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  new.term := btrim(new.term);
  new.variants := coalesce(
    (select array_agg(distinct btrim(v)) from unnest(new.variants) v where btrim(v) <> ''),
    '{}');
  new.updated_at := now();

  if new.status = 'approved'
     and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    if not exists (select 1 from organizations o
                   where o.id = new.approved_by_org and o.is_verified) then
      raise exception 'Only a verified organisation can approve a lexicon entry';
    end if;
    new.approved_at := now();
  end if;
  return new;
end $$;

create trigger lexicon_before_write
  before insert or update on lexicon_entries
  for each row execute function public.lexicon_before_write();

-- H4. Lexicon audit log
create or replace function public.lexicon_log_change()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into lexicon_audit (entry_id, action, changed_by, old_row, new_row)
  values (coalesce(new.id, old.id), lower(tg_op), auth.uid(),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end $$;

create trigger lexicon_audit_log
  after insert or update or delete on lexicon_entries
  for each row execute function public.lexicon_log_change();

-- H5. Reports: mark duplicates automatically (same post reported again within
--     7 days) and lock the screenshot + hash once they are set
create or replace function public.reports_before_write()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.duplicate_of is null then
    select r.id into new.duplicate_of
    from reports r
    where r.url_key = lower(regexp_replace(new.url, '(#.*$)|(/+$)', '', 'g'))
      and r.duplicate_of is null
      and r.reported_at > now() - interval '7 days'
    order by r.reported_at
    limit 1;
  end if;

  if tg_op = 'UPDATE' and old.screenshot_sha256 is not null
     and (new.screenshot_sha256 is distinct from old.screenshot_sha256
          or new.screenshot_path is distinct from old.screenshot_path) then
    raise exception 'Evidence is locked: the screenshot and its hash cannot be changed once saved';
  end if;
  return new;
end $$;

create trigger reports_before_write
  before insert or update on reports
  for each row execute function public.reports_before_write();

-- H6. Evidence files can't be edited. (Deleting is still allowed for the
--     owner, because data-protection law gives people the right to delete.)
create or replace function public.incident_files_no_edit()
returns trigger language plpgsql
as $$
begin
  -- the only change allowed is the uploader's account being deleted
  if row(new.id, new.incident_id, new.file_path, new.file_kind, new.mime_type,
         new.size_bytes, new.sha256, new.uploaded_at)
     is distinct from
     row(old.id, old.incident_id, old.file_path, old.file_kind, old.mime_type,
         old.size_bytes, old.sha256, old.uploaded_at)
     or new.uploaded_by is not null and new.uploaded_by is distinct from old.uploaded_by then
    raise exception 'Evidence is locked: incident files cannot be edited once saved';
  end if;
  return new;
end $$;

create trigger incident_files_no_edit
  before update on incident_files
  for each row execute function public.incident_files_no_edit();


-- =====================================================================
-- PART I. SECURITY HELPERS + ROW LEVEL SECURITY
-- =====================================================================

create or replace function public.current_app_role()
returns text language sql stable security definer set search_path = public
as $$ select role from profiles where id = auth.uid() $$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce((select role = 'admin' from profiles where id = auth.uid()), false) $$;

create or replace function public.my_org_id()
returns uuid language sql stable security definer set search_path = public
as $$ select organization_id from profiles where id = auth.uid() $$;

-- A reviewer = member of a VERIFIED organisation (or an admin)
create or replace function public.is_verified_reviewer()
returns boolean language sql stable security definer set search_path = public
as $$
  select is_admin() or exists (
    select 1 from profiles p join organizations o on o.id = p.organization_id
    where p.id = auth.uid() and p.role = 'org_member' and o.is_verified)
$$;

-- Can the current user see this leader's private data?
-- Yes if: she is the leader, or a member of her designated verified org, or an admin.
create or replace function public.can_access_leader(p_leader_id uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select is_admin() or exists (
    select 1 from leaders l
    where l.id = p_leader_id
      and (l.profile_id = auth.uid()
           or (l.organization_id is not null
               and l.organization_id = my_org_id()
               and is_verified_reviewer())))
$$;

create or replace function public.incident_leader(p_incident_id uuid)
returns uuid language sql stable security definer set search_path = public
as $$ select leader_id from incidents where id = p_incident_id $$;

alter table countries          enable row level security;
alter table languages          enable row level security;
alter table categories         enable row level security;
alter table subtypes           enable row level security;
alter table organizations      enable row level security;
alter table profiles           enable row level security;
alter table lexicon_entries    enable row level security;
alter table lexicon_audit      enable row level security;
alter table legal_info         enable row level security;
alter table platform_reporting enable row level security;
alter table next_steps         enable row level security;
alter table leaders            enable row level security;
alter table events             enable row level security;
alter table reports            enable row level security;
alter table alerts             enable row level security;
alter table incidents          enable row level security;
alter table incident_files     enable row level security;

-- Public reference data: anyone can read, only admins change it
create policy "public read" on countries          for select using (true);
create policy "public read" on languages          for select using (true);
create policy "public read" on categories         for select using (true);
create policy "public read" on subtypes           for select using (true);
create policy "public read" on organizations      for select using (true);
create policy "public read" on legal_info         for select using (true);
create policy "public read" on platform_reporting for select using (true);
create policy "public read" on next_steps         for select using (true);

create policy "admin write" on countries          for all using (is_admin()) with check (is_admin());
create policy "admin write" on languages          for all using (is_admin()) with check (is_admin());
create policy "admin write" on categories         for all using (is_admin()) with check (is_admin());
create policy "admin write" on subtypes           for all using (is_admin()) with check (is_admin());
create policy "admin write" on organizations      for all using (is_admin()) with check (is_admin());
create policy "admin write" on legal_info         for all using (is_admin()) with check (is_admin());
create policy "admin write" on platform_reporting for all using (is_admin()) with check (is_admin());
create policy "admin write" on next_steps         for all using (is_admin()) with check (is_admin());

-- Profiles: you see your own; you can rename yourself but not change your role or org
create policy "see own profile" on profiles for select
  using (id = auth.uid() or is_admin());
create policy "edit own name" on profiles for update
  using (id = auth.uid())
  with check (id = auth.uid()
              and role = current_app_role()
              and organization_id is not distinct from my_org_id());
create policy "admin manage profiles" on profiles for all
  using (is_admin()) with check (is_admin());

-- Lexicon: approved entries are public (open dataset). Pending ones are
-- visible only to reviewers and to the person who submitted them.
create policy "read lexicon" on lexicon_entries for select
  using (status = 'approved' or is_verified_reviewer() or submitted_by = auth.uid());
create policy "suggest a term" on lexicon_entries for insert to authenticated
  with check (status = 'pending' and source = 'community'
              and submitted_by = auth.uid() and approved_by_org is null);
create policy "reviewers edit" on lexicon_entries for update
  using (is_verified_reviewer())
  with check (is_verified_reviewer()
              and (is_admin() or approved_by_org is null or approved_by_org = my_org_id()));
create policy "admin delete" on lexicon_entries for delete using (is_admin());

create policy "reviewers read audit" on lexicon_audit for select using (is_verified_reviewer());

-- Leaders, events, alerts, incidents: only she, her verified org, or an admin
create policy "leader access" on leaders for select using (can_access_leader(id));
create policy "leader edit"   on leaders for update using (can_access_leader(id)) with check (can_access_leader(id));
create policy "admin manage leaders" on leaders for all using (is_admin()) with check (is_admin());

create policy "event access" on events for all
  using (can_access_leader(leader_id)) with check (can_access_leader(leader_id));

create policy "alert read"   on alerts for select using (can_access_leader(leader_id));
create policy "alert seen"   on alerts for update
  using (can_access_leader(leader_id)) with check (can_access_leader(leader_id));

create policy "incident access" on incidents for all
  using (can_access_leader(leader_id)) with check (can_access_leader(leader_id));

create policy "file read"   on incident_files for select using (can_access_leader(incident_leader(incident_id)));
create policy "file add"    on incident_files for insert with check (can_access_leader(incident_leader(incident_id)));
create policy "file delete" on incident_files for delete using (can_access_leader(incident_leader(incident_id)));

-- Reports: written only by the backend. Readable by the person who sent it,
-- or by the leader / her org for reports about her.
create policy "report read" on reports for select
  using (reporter_id = auth.uid() or can_access_leader(leader_id));
create policy "report review" on reports for update
  using (can_access_leader(leader_id)) with check (can_access_leader(leader_id));


-- =====================================================================
-- PART J. FUNCTIONS AND VIEWS FOR THE BACKEND
-- =====================================================================

-- J1. GET /lexicon -> select lexicon_export('PH', array['tl','en']);
--     Returns only approved entries, in the JSON shape the extension expects.
--     "version" changes whenever the lexicon changes, so the extension can
--     skip re-downloading when nothing is new.
create or replace function public.lexicon_export(
  p_country   text   default null,
  p_languages text[] default null
)
returns jsonb language sql stable set search_path = public
as $$
  with rows as (
    select e.*, c.name as category_name, s.name as subtype_name
    from lexicon_entries e
    join categories c on c.code = e.category_code
    left join subtypes s on s.category_code = e.category_code and s.code = e.subtype_code
    where e.status = 'approved'
      and (p_country is null or e.country_code is null or e.country_code = upper(p_country))
      and (p_languages is null or e.language_code = any (p_languages))
  )
  select jsonb_build_object(
    'version', (select max(updated_at) from lexicon_entries),
    'count',   (select count(*) from rows),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',            id,
               'term',          term,
               'variants',      variants,
               'entry_type',    entry_type,
               'language',      language_code,
               'country',       country_code,
               'meaning',       meaning,
               'category',      category_code,
               'category_name', category_name,
               'subtype',       subtype_code,
               'subtype_name',  subtype_name,
               'severity',      severity,
               'is_urgent',     is_urgent,
               'context_note',  context_note)
             order by language_code, term)
      from rows), '[]'::jsonb))
$$;

-- J2. GET /legal-info -> select popup_info('PH');
--     Law + reporting route for the country, platform links, and next steps.
create or replace function public.popup_info(p_country text)
returns jsonb language sql stable set search_path = public
as $$
  select jsonb_build_object(
    'country',    upper(p_country),
    'legal',      (select to_jsonb(l) - 'updated_at' from legal_info l where l.country_code = upper(p_country)),
    'platforms',  coalesce((select jsonb_agg(to_jsonb(p) order by p.platform) from platform_reporting p), '[]'::jsonb),
    'next_steps', coalesce((select jsonb_object_agg(n.guidance_key || ':' || n.audience, n.steps) from next_steps n), '{}'::jsonb))
$$;

-- J3. Triage helper: which registered leaders does this text mention?
--     select * from match_leaders('Sec. Reyes should resign');
create or replace function public.match_leaders(p_text text)
returns table (leader_id uuid, full_name text, matched_name text)
language sql stable security definer set search_path = public
as $$
  select distinct on (l.id) l.id, l.full_name, n.name
  from leaders l
  cross join lateral unnest(array_prepend(l.full_name, l.name_variants)) as n(name)
  where length(n.name) >= 3
    and position(lower(n.name) in lower(p_text)) > 0
  order by l.id, length(n.name) desc
$$;

-- J4. Spike detection. The backend runs this every hour:
--       select * from run_spike_check();
--     A leader gets an alert when, in the last 24 hours, reports about her
--     are at least p_ratio x her daily average for the 7 days before,
--     AND at least p_min_reports (so 1 -> 3 reports doesn't fire).
--     Duplicates don't count. One alert per leader per cooldown period.
--     Returns the new alerts so the backend can add the AI summary.
create or replace function public.run_spike_check(
  p_ratio       numeric  default 3,
  p_min_reports int      default 5,
  p_cooldown    interval default '12 hours'
)
returns setof alerts
language plpgsql security definer set search_path = public
as $$
begin
  return query
  with stats as (
    select l.id as leader_id,
           count(*) filter (where r.reported_at > now() - interval '24 hours') as recent,
           count(*) filter (where r.reported_at <= now() - interval '24 hours'
                              and r.reported_at >  now() - interval '8 days') / 7.0 as baseline,
           bool_or(r.is_demo) filter (where r.reported_at > now() - interval '24 hours') as has_demo
    from leaders l
    join reports r on r.leader_id = l.id and r.duplicate_of is null
                  and r.reported_at > now() - interval '8 days'
    where l.alerts_opt_in
    group by l.id
  ),
  spikes as (
    select s.* from stats s
    where s.recent >= p_min_reports
      and (s.baseline = 0 or s.recent >= p_ratio * s.baseline)
      and not exists (select 1 from alerts a
                      where a.leader_id = s.leader_id
                        and a.triggered_at > now() - p_cooldown)
  )
  insert into alerts (leader_id, event_id, reports_last_24h, daily_avg_prev_7d,
                      ratio, top_categories, is_demo)
  select sp.leader_id,
         (select e.id from events e
          where e.leader_id = sp.leader_id
            and e.starts_at between now() - interval '1 day' and now() + interval '14 days'
          order by e.starts_at limit 1),
         sp.recent,
         round(sp.baseline, 2),
         case when sp.baseline > 0 then round(sp.recent / sp.baseline, 2) end,
         (select jsonb_object_agg(coalesce(t.category_code, 'unclassified'), t.n)
          from (select r.category_code, count(*) as n from reports r
                where r.leader_id = sp.leader_id and r.duplicate_of is null
                  and r.reported_at > now() - interval '24 hours'
                group by r.category_code) t),
         coalesce(sp.has_demo, false)
  from spikes sp
  returning *;
end $$;

-- J5. Demo button: inject fake reports about a leader so the spike fires live.
--     select inject_demo_reports('<leader id>', 25);
create or replace function public.inject_demo_reports(p_leader_id uuid, p_count int default 25)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  samples text[][] := array[
    array['Everyone knows how she got that seat 🍆🔥', 'gendered_disinformation', 'sexual_rumour', 'facebook'],
    array['No husband to keep her in check, of course she votes like that 😂', 'gender_hate_speech', 'gendered_competence_attack', 'x'],
    array['#Presstitute spreading fake news again', 'gender_hate_speech', 'sexist_insult', 'x'],
    array['She said women who protest deserve what they get', 'manipulated_text', 'fabricated_quote', 'facebook'],
    array['Always posting about harassment, just an attention seeker 😂', 'gender_hate_speech', 'victim_blaming', 'tiktok'],
    array['Too emotional to lead a country', 'gender_hate_speech', 'gendered_competence_attack', 'instagram']
  ];
  v_country char(2);
  i int;
  k int;
begin
  select country_code into v_country from leaders where id = p_leader_id;
  if v_country is null then
    raise exception 'Leader % not found', p_leader_id;
  end if;

  for i in 1 .. p_count loop
    k := 1 + (i % array_length(samples, 1));
    insert into reports (url, platform, flagged_text, category_code, subtype_code,
                         language_code, country_code, leader_id, reporter_role,
                         is_demo, reported_at)
    values ('https://example.com/demo-post/' || gen_random_uuid(),
            samples[k][4], samples[k][1], samples[k][2], samples[k][3],
            'en', v_country, p_leader_id,
            (array['target', 'ally', 'organization'])[1 + (i % 3)],
            true,
            now() - (random() * interval '3 hours'));
  end loop;
  return p_count;
end $$;

-- J6. Reset the demo (removes only injected reports and demo alerts)
create or replace function public.clear_demo_data()
returns void language sql security definer set search_path = public
as $$
  delete from alerts  where is_demo;
  delete from reports where is_demo;
$$;

-- J7. Dashboard / government stats view: counts only, no message text
create view report_daily_stats with (security_invoker = true) as
select date_trunc('day', reported_at)::date as day,
       country_code,
       platform,
       category_code,
       subtype_code,
       count(*)                                   as reports,
       count(*) filter (where is_urgent)          as urgent_reports,
       count(distinct leader_id)                  as leaders_targeted
from reports
where duplicate_of is null
group by 1, 2, 3, 4, 5;

-- J8. Review queue for the website: pending entries, oldest first
create view lexicon_review_queue with (security_invoker = true) as
select id, term, variants, entry_type, language_code, country_code, meaning,
       category_code, subtype_code, severity, context_note,
       raw_submission, ai_draft, created_at
from lexicon_entries
where status = 'pending'
order by created_at;

-- Table permissions. (Supabase usually grants these automatically; stating
-- them makes sure the website works on newer projects too. The row level
-- security policies above still decide which ROWS each person sees.)
grant usage on schema public to anon, authenticated, service_role;
grant select on all tables in schema public to anon;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
grant execute on function public.lexicon_export(text, text[]) to anon, authenticated, service_role;
grant execute on function public.popup_info(text)             to anon, authenticated, service_role;

-- Functions that change data are for the backend (service_role) only
revoke execute on function public.run_spike_check(numeric, int, interval) from public, anon, authenticated;
revoke execute on function public.inject_demo_reports(uuid, int)          from public, anon, authenticated;
revoke execute on function public.clear_demo_data()                       from public, anon, authenticated;
revoke execute on function public.match_leaders(text)                     from public, anon, authenticated;
grant  execute on function public.run_spike_check(numeric, int, interval) to service_role;
grant  execute on function public.inject_demo_reports(uuid, int)          to service_role;
grant  execute on function public.clear_demo_data()                       to service_role;
grant  execute on function public.match_leaders(text)                     to service_role;


-- =====================================================================
-- PART K. FILE STORAGE (private buckets; only the backend can read/write,
-- and it hands out short-lived signed URLs for viewing)
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('report-screenshots', 'report-screenshots', false, 5242880,          -- 5 MB
   array['image/png', 'image/jpeg', 'image/webp']),
  ('incident-files', 'incident-files', false, 52428800,                 -- 50 MB
   array['image/png', 'image/jpeg', 'image/webp', 'image/heic',
         'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/webm', 'audio/ogg', 'audio/wav',
         'video/mp4', 'application/pdf'])
on conflict (id) do nothing;
