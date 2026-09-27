# Database (Supabase)

The shared online database behind Kalasag. Only the website (`website/app.py`) talks to it. The extension talks to the website, never to the database directly.

```
Extension ──► Website (app.py) ──► Supabase
 (reads words,     (dashboard,          (words, reports,
  saves evidence)   alerts, trends)       leaders, alerts)
```

## Set up (once)

1. In Supabase, open **SQL Editor → New query**, paste `schema.sql` and click **Run**. Confirm the warning: the file first removes any older version of the tables.
2. In the `website` folder, copy `.env.example` to `.env` and paste the **secret** key from **Project Settings → API Keys**.
3. Start the website: `python app.py`. On its first start it adds the demo data.

## Tables

| Table | Holds |
|---|---|
| `categories` | The 9 detailed categories, each linked to one of the guide's broad categories |
| `lexicon` | The word database: term, spelling variants, meaning, category, severity, context note, review status |
| `lexicon_audit` | Every change to the word database, so edits and removals can be traced and undone |
| `leaders`, `events` | Registered leaders, their nicknames, and upcoming events |
| `reports` | Evidence saved from the extension, with the screenshot fingerprint (SHA-256) |
| `alerts` | Spike alerts |
| `incidents` | Incidents a leader documents, with fingerprinted files |

Screenshots and incident files go in the private storage bucket `evidence`.

## Security

- Row level security is on for every table, with no public rules. The publishable key can't read or change anything; only the secret key (on the website's computer) can.
- A saved screenshot and its fingerprint can't be changed afterwards (the database refuses).
- Keep the secret key only in `website/.env`, which git ignores.

## Useful queries (SQL Editor)

```sql
-- Reports per leader in the last 7 days
select l.name, count(*) from reports r join leaders l on l.id = r.leader_id
where r.created_at > now() - interval '7 days' group by l.name order by 2 desc;

-- Reports by broad category
select c.broad_label, count(*) from reports r join categories c on c.code = r.category group by 1;

-- Words waiting for review
select id, term, language, raw_submission from lexicon where status = 'pending';
```
