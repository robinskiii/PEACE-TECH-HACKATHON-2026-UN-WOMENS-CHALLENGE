-- Expert review for reports (run once in the Supabase SQL Editor if your tables were created before this file existed).
-- Adds columns only: existing reports keep their data and count as approved.
--   source: where the report came from. word_list = matched a verified word,
--           ai = found by the AI check, highlight = text a person highlighted.
--   status: pending until an expert approves it. Only approved reports count
--           in Trends, spike alerts and the reports list.

alter table reports add column if not exists source        text not null default 'word_list';
alter table reports add column if not exists status        text not null default 'approved';
alter table reports add column if not exists reporter_note text;
alter table reports add column if not exists reviewed_by   text;
alter table reports add column if not exists reviewed_at   timestamptz;

alter table reports drop constraint if exists reports_source_check;
alter table reports add constraint reports_source_check check (source in ('word_list', 'ai', 'highlight'));
alter table reports drop constraint if exists reports_status_check;
alter table reports add constraint reports_status_check check (status in ('pending', 'approved', 'rejected'));

create index if not exists reports_status_idx on reports (status, created_at desc);
