# Database (Supabase)

The database behind Reality Check. It stores:

- the **word list (lexicon)**: local-language terms, what they mean, their category, and when they're harmful
- **reports** sent from the extension, with a screenshot fingerprint (SHA-256)
- **leaders and their events**, for early-warning alerts (private)
- **alerts** when reports about a leader suddenly spike
- **incidents** a leader documents (notes, photos, voice notes)
- **pop-up content**: laws, reporting links and "what to do next" steps per country

---

## 1. Setup

1. Create a project at [supabase.com](https://supabase.com) (the free plan is enough).
2. Open **SQL Editor → New query** and run these files **in order**, once each:

   | File | What it creates |
   |---|---|
   | `01_schema.sql` | Tables, security rules, functions, storage buckets |
   | `02_reference_data.sql` | Categories, subtypes, countries, languages, laws, reporting links, next steps |
   | `03_demo_seed.sql` | Demo data: fictional leaders, sample words, a week of reports |

   If Supabase shows a warning pop-up about RLS or destructive operations, choose to run without adding RLS. The script already turns on security for every table.

3. Check it worked:
   ```sql
   select lexicon_export('PH', array['tl','en']);
   ```
   The result should include `"count": 18`.

## 2. Keys

Find them in **Project Settings → API Keys**.

| Key | Where it goes | Safe to share? |
|---|---|---|
| Project URL | Everywhere | Yes |
| **Publishable** key (old name: anon) | Extension, website | Yes: it can only read approved, public data |
| **Secret** key (old name: service_role) | Backend `.env` only | **No**: it bypasses all security rules |

## 3. Tables

| Table | Holds | Who can read it |
|---|---|---|
| `lexicon_entries` | Words, variants, meaning, category, severity, context note, status | Everyone sees **approved** words; reviewers see all |
| `lexicon_review_queue` (view) | Words waiting for review | Reviewers |
| `lexicon_audit` | Every change to the word list | Reviewers |
| `categories`, `subtypes` | The 4 categories and their subtypes | Everyone |
| `countries`, `languages` | Supported countries and languages | Everyone |
| `organizations` | Partner organisations; `is_verified` controls who can approve | Everyone |
| `profiles` | Each user's role: `community`, `org_member`, `leader`, `admin` | The user themself |
| `leaders`, `events` | Registered leaders, nicknames, upcoming events (city only) | The leader, her organisation, admins |
| `reports` | Flagged posts from the extension | The reporter; the leader and her organisation |
| `alerts` | Spike alerts and their AI summaries | The leader and her organisation |
| `incidents`, `incident_files` | Documented incidents and evidence files | The leader and her organisation |
| `legal_info`, `platform_reporting`, `next_steps` | Pop-up content | Everyone |
| `report_daily_stats` (view) | Report counts by day, country and category, with no message text | For dashboards |

**Rules the database enforces on its own:**
- New words are always saved as `pending`. Only a member of a **verified** organisation (or an admin) can approve them.
- Once a screenshot hash or an evidence file is saved, it can't be edited.
- If the same post URL is reported again within 7 days, it's marked as a duplicate and doesn't count towards spikes.
- Every change to the word list is logged in `lexicon_audit`.

## 4. Using it from the backend

```python
from supabase import create_client
sb = create_client(SUPABASE_URL, SUPABASE_SECRET_KEY)
```

**Word list** (the extension already reads this directly with the publishable key):
```python
sb.rpc("lexicon_export", {"p_country": "PH", "p_languages": ["tl", "en"]}).execute().data
# → {"version": "...", "count": 18, "entries": [{term, variants, meaning, category, subtype, severity, is_urgent, context_note, ...}]}
```

**Pop-up content** (law, reporting links, next steps):
```python
sb.rpc("popup_info", {"p_country": "PH"}).execute().data
```

**Save a report** (`POST /reports`):
```python
import hashlib
digest = hashlib.sha256(screenshot_bytes).hexdigest()
sb.storage.from_("report-screenshots").upload(path, screenshot_bytes, {"content-type": "image/png"})
leader = sb.rpc("match_leaders", {"p_text": flagged_text}).execute().data   # which leader is mentioned?
sb.table("reports").insert({
    "url": url, "platform": "facebook", "flagged_text": flagged_text,
    "category_code": "gender_hate_speech", "subtype_code": "sexist_insult",
    "language_code": "tl", "country_code": "PH",
    "leader_id": leader[0]["leader_id"] if leader else None,
    "reporter_role": "ally",                     # target / ally / organization
    "screenshot_path": path, "screenshot_sha256": digest,
}).execute()
```

**Submit a new word** (with the AI draft):
```python
sb.table("lexicon_entries").insert({
    "term": term, "language_code": "tl", "country_code": "PH",
    "category_code": "gender_hate_speech", "raw_submission": raw_text, "ai_draft": ai_json,
    "status": "pending", "source": "community", "submitted_by": user_id,
}).execute()
```

**Spike check** (run every hour):
```python
new_alerts = sb.rpc("run_spike_check", {}).execute().data
for a in new_alerts:
    sb.table("alerts").update({"ai_summary": summarise(a)}).eq("id", a["id"]).execute()
```
An alert fires when a leader gets at least **3×** her usual daily reports in 24 hours, and at least **5** reports. You can change this: `{"p_ratio": 2, "p_min_reports": 3}`.

**Evidence files**: both buckets are private. To show a file, create a short-lived link:
```python
sb.storage.from_("incident-files").create_signed_url(path, 600)
```

## 5. Common tasks (SQL Editor)

**Add a word**
```sql
insert into lexicon_entries
  (term, variants, language_code, country_code, meaning,
   category_code, subtype_code, severity, context_note)
values
  ('the word', array['sp3lling variant'], 'tl', 'PH', 'What it means',
   'gender_hate_speech', 'sexist_insult', 'high', 'When it is and is not harmful');
```

**Approve a word** (the organisation must be verified)
```sql
update lexicon_entries
set status = 'approved', approved_by_org = 'a0000000-0000-0000-0000-000000000001'
where term = 'the word';
```

**Reject a word**
```sql
update lexicon_entries set status = 'rejected', reviewer_note = 'Reason' where term = 'the word';
```

**Give a user a role.** First create the user in **Authentication → Users → Add user**, then:
```sql
update profiles set role = 'org_member', organization_id = 'a0000000-0000-0000-0000-000000000001'
where id = (select id from auth.users where email = 'reviewer@example.com');
```

**Run the spike demo**
```sql
select inject_demo_reports('b0000000-0000-0000-0000-000000000001', 25);
select * from run_spike_check();
select clear_demo_data();   -- reset afterwards
```

## 6. Demo data

All people and organisations are fictional. Non-English slurs are placeholders such as `PLACEHOLDER_TL_SLUR_01`.

| What | ID |
|---|---|
| Maria Reyes (minister, PH) | `b0000000-0000-0000-0000-000000000001` |
| Asha Verma (MP, IN) | `b0000000-0000-0000-0000-000000000002` |
| Demo Women's Rights Network (verified) | `a0000000-0000-0000-0000-000000000001` |
| UN Women PH office (verified, Reyes's org) | `a0000000-0000-0000-0000-000000000002` |
| Demo Community Collective IN (verified, Verma's org) | `a0000000-0000-0000-0000-000000000003` |
| Unverified Test Group | `a0000000-0000-0000-0000-000000000004` |

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| `relation ... already exists` / `duplicate key` | A file was run twice. Only run each file once per project. |
| `Only a verified organisation can approve` | Use a verified organisation's ID in `approved_by_org`. |
| `Evidence is locked` | Saved hashes and evidence files can't be changed. Upload a new file instead. |
| The extension gets `permission denied` | It's using the wrong key. The extension needs the **publishable** key. |
| Project not responding | Free projects pause after a week without use. Open the dashboard and click **Restore**. |
