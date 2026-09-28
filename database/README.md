# Kalasag data layer

Kalasag can run entirely on one computer, using SQLite, or use this Supabase schema as a shared workspace for a team. The application presents the same storage interface in both modes; the browser extension always communicates with the [website API](../website/README.md), never directly with Supabase.

```text
Browser extension ──► Kalasag website (`app.py`) ──► SQLite or Supabase
       reads approved terms,     reviews, trends,       structured records
       saves evidence            alerts, evidence       + evidence files
```

## Data model

| Data | What it represents | How it is used |
|---|---|---|
| `categories` | Detailed categories and their broader guide categories | Classifying lexicon terms and reports. |
| `lexicon` | Community terms, spelling variants, meaning, language/country, severity, context note, submitter, and review status | Only `approved` entries are delivered to browser extensions. |
| `lexicon_audit` | Before/after record of every lexicon insert, update, or delete | Lets a team trace changes to the vocabulary. |
| `leaders` | A monitored woman leader, name variants, organization, and alert contact | Allows the server to recognize targets in report text. |
| `events` | An upcoming leader event and location | Displayed with the corresponding leader in the dashboard. |
| `reports` | Saved web-content evidence and its review state | Powers the review queue, trends, and alerts. |
| `alerts` | A per-leader volume spike and summary | Shown as the early-warning feed. |
| `incidents` | A broader incident record, witnesses, and attachment references | Keeps documentation separate from individual online reports. |

Evidence files live outside the relational tables. Supabase uses a private `evidence` bucket with a 50 MB file limit; local mode writes them under `website/evidence/`. The database row records the generated file name and SHA-256 fingerprint.

## Report lifecycle

```text
Extension report
   │
   ├─ approved lexicon hit ───────────────► approved ─► trends + spike checks
   │
   ├─ LLM-only finding ─┐
   └─ user-highlighted ─┴───────────────► pending ──► expert approves/rejects
                                                       │
                                                       └─ approved reports enter trends + spike checks
```

The `source` field is `word_list`, `ai`, or `highlight`; `status` is `pending`, `approved`, or `rejected`. The server counts only approved reports when calculating trends and alerts.

For a report with a screenshot fingerprint, the `reports_lock_evidence` trigger prevents the associated screenshot name or SHA-256 value from being changed through a later row update. This supports evidence integrity, but it is not a substitute for production access controls, backups, or a formal chain-of-custody process.

## Set up Supabase

The local SQLite mode needs no work in this folder. Use Supabase when several people need the same data.

1. Create a Supabase project.
2. In **SQL Editor**, run [`schema.sql`](schema.sql).
3. In [`../website`](../website), copy `.env.example` to `.env` and set `SUPABASE_URL` plus the project’s `SUPABASE_SECRET_KEY`.
4. Start `python app.py` from the `website` folder. It checks that the tables exist and seeds its demo data if the lexicon is empty.

`schema.sql` begins by dropping the existing Kalasag tables, functions, and views. Run it only for a fresh demo instance or when deliberately replacing an existing Kalasag dataset.

For a Supabase database created before pending report review was added, run [`migrations/002_report_review.sql`](migrations/002_report_review.sql) once. It adds `source`, `status`, reporter notes, and reviewer metadata without removing existing records; pre-existing reports remain approved.

## Community source list

[`word_list.json`](word_list.json) is a reference catalogue of 32 terms from the team’s guide: 24 entries are marked for flagging and 8 are contextual/reference signals. It contains the source, country, language, meaning, category, severity, and a `flag` field.

The file is **not imported automatically** by `app.py`. Treat it as source material: submit applicable terms through the website’s Word database, check their spelling variants and context notes with language-aware reviewers, then approve them. That approval is what makes a term available to extensions. Terms with `"flag": false` should not generate a flag on their own.

The app’s small fictional seed lexicon is separate from this catalogue and exists only to make the demo work immediately.

## Supabase security boundary

The schema enables row-level security on every application table and creates no public table policies. It grants access to the Supabase `service_role`, which is what the website server uses; the browser extension has neither the Supabase URL/key configuration nor direct database calls. The evidence bucket is private.

This protects the database from public Supabase-table access, but the demo website API itself currently has no login, user roles, or per-organization authorization. Anyone who can reach that API can use the functions it exposes. A production deployment must add authenticated application roles, server-side authorization checks, restricted CORS, audited administrator access, HTTPS, and appropriate consent/retention controls before storing real incidents or evidence.

## Useful checks in the Supabase SQL Editor

```sql
-- Approved reports about each leader in the past seven days
select l.name, count(*) as reports
from reports r
join leaders l on l.id = r.leader_id
where r.status = 'approved'
  and r.created_at > now() - interval '7 days'
group by l.name
order by reports desc;

-- Terms that still need a human decision
select id, term, language, country, submitted_by, created_at
from lexicon
where status = 'pending'
order by created_at desc;

-- Reports waiting for expert review
select id, source, category, matched_text, url, created_at
from reports
where status = 'pending'
order by created_at desc;
```
