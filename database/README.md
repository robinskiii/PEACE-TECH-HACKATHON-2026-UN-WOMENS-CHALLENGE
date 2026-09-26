# Database (Supabase): hand-off for the team

This is the database for the Gendered Disinformation Detector. It covers the lexicon, reports, leaders and events, alerts, and incident evidence. The backend (FastAPI) is the only part that writes to it. The extension never talks to it directly.

## Status: live

The database is set up in the Supabase project **"UN Women"** (region: West EU / Ireland), and all three files have been run. The project address is `https://ghjomcqfzvhmamloypjz.supabase.co`. It was checked on 26 Sep 2026: 17 tables, all with row-level security, 25 approved words, and the public key sees only approved words. Get the keys from **Project Settings → API Keys**. The secret key goes only to the backend person, sent privately.

## 1. Set it up (10 minutes), only for a new project

1. Create a Supabase project. Pick the **Singapore** region (closest to our users).
2. Go to **SQL Editor > New query**, and run these files in order:
   1. `01_schema.sql`: tables, rules, security, functions, storage buckets
   2. `02_reference_data.sql`: categories, subtypes, countries, languages, legal info, platform links, next steps (all from our category guide)
   3. `03_demo_seed.sql`: demo data (fictional leaders, about 30 lexicon entries, a week of reports, one incident)
3. Go to **Project Settings > API** and copy:
   - **Project URL**: needed by the backend.
   - **service_role key**: backend `.env` only. Never put it in the extension, the website code, or git. It skips all security rules.
   - **anon key**: only if the website uses Supabase login. It is safe to be public.

> Free projects pause after 1 week without activity. Open the dashboard the day before the demo.

## 2. What's in it

| Table | What it holds | Who can see it (with the anon key or a login) |
|---|---|---|
| `categories`, `subtypes` | The 4 categories and their subtypes from the guide | Everyone |
| `countries`, `languages` | PH, AU, FJ, IN, PK, ID, VN / en, tl, hi, ur, fj, id, vi | Everyone |
| `organizations` | Partner orgs; `is_verified` decides who can approve | Everyone |
| `profiles` | One per logged-in user: role (`community`, `org_member`, `leader`, `admin`) and org | Yourself |
| `lexicon_entries` | Terms, variants, meaning, category, severity, context note, status | **Approved**: everyone. **Pending**: reviewers from verified orgs, and the person who submitted it |
| `lexicon_audit` | Every change to the lexicon (who, when, before and after) | Reviewers |
| `leaders` | Name, nicknames and hashtags (`name_variants`), country, her support org | She, her verified org, admins |
| `events` | Her upcoming rallies and speeches (city only, never the address) | She, her verified org, admins |
| `reports` | Flagged posts from the extension | The reporter, and she and her org for reports about her |
| `alerts` | Spike alerts plus the AI summary | She, her verified org |
| `incidents`, `incident_files` | Her documented incidents and evidence files with SHA-256 hashes | She, her verified org |
| `legal_info`, `platform_reporting`, `next_steps` | Pop-up content | Everyone |

Rules the database enforces by itself:
- **Nothing reaches the extension unless it's approved**, and only a **verified** org can approve. A community user can only submit `pending` entries.
- **Evidence is locked.** Once a screenshot hash or an incident file is saved, it can't be edited. It can still be deleted by the owner, because of data-protection law.
- **Duplicates are marked automatically.** If the same post URL is reported again within 7 days, `duplicate_of` points to the first report, and it doesn't count toward spikes.
- **Every lexicon change is logged** in `lexicon_audit`. This is our answer to "what if trolls poison the database?"

## 3. What the backend calls, per endpoint

Python, with `pip install supabase`:

```python
from supabase import create_client
sb = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
```

**GET /lexicon?country=PH&languages=tl,en**
```python
data = sb.rpc("lexicon_export", {"p_country": "PH", "p_languages": ["tl", "en"]}).execute().data
# -> {"version": "...", "count": 18, "entries": [ {term, variants, language, country, meaning,
#     category, category_name, subtype, subtype_name, severity, is_urgent, context_note, ...} ]}
```
Entries with `country = null` are region-wide (English) and are always included. The extension can store `version` and skip re-downloading when it hasn't changed.

**GET /legal-info?country=PH**
```python
data = sb.rpc("popup_info", {"p_country": "PH"}).execute().data
# -> {legal: {...}, platforms: [...], next_steps: {"urgent:any": [...], "gender_hate_speech:any": [...], "all:ally": [...]}}
```

**POST /reports**
```python
import hashlib, uuid
digest = hashlib.sha256(screenshot_bytes).hexdigest()          # hash BEFORE storing
path = f"{uuid.uuid4()}.png"
sb.storage.from_("report-screenshots").upload(path, screenshot_bytes, {"content-type": "image/png"})
leader = sb.rpc("match_leaders", {"p_text": flagged_text}).execute().data   # who is mentioned?
sb.table("reports").insert({
    "url": url, "platform": "facebook", "flagged_text": flagged_text,
    "matched_entry_id": entry_id, "matched_text": matched_text,
    "category_code": "gender_hate_speech", "subtype_code": "sexist_insult",
    "is_urgent": False, "classification": ai_result_json,
    "language_code": "tl", "country_code": "PH",
    "leader_id": leader[0]["leader_id"] if leader else None,
    "reporter_role": "ally",                 # target / ally / organization
    "screenshot_path": path, "screenshot_sha256": digest,
}).execute()
```
Only send the flagged sentence, not the whole page.

**Lexicon submission and review**
```python
# community submission + AI draft
sb.table("lexicon_entries").insert({"term": ..., "language_code": "tl", "country_code": "PH",
    "category_code": ..., "raw_submission": raw_text, "ai_draft": ai_json,
    "status": "pending", "source": "community", "submitted_by": user_id}).execute()
# review queue page
sb.table("lexicon_review_queue").select("*").execute()
# reviewer approves (approved_by_org must be a VERIFIED org, or the database refuses)
sb.table("lexicon_entries").update({"status": "approved", "approved_by": reviewer_id,
    "approved_by_org": reviewer_org_id, "meaning": ..., "variants": [...]}).eq("id", entry_id).execute()
```

**Spike check (run every hour)**
```python
new_alerts = sb.rpc("run_spike_check", {}).execute().data
for a in new_alerts:
    summary = ask_ai_for_summary(a["leader_id"])          # your AI call
    sb.table("alerts").update({"ai_summary": summary}).eq("id", a["id"]).execute()
```
The defaults are 3 times the leader's 7-day daily average, at least 5 reports in 24 hours, and at most one alert per leader every 12 hours. You can change them: `{"p_ratio": 2, "p_min_reports": 3}`.

**Demo button**
```python
sb.rpc("inject_demo_reports", {"p_leader_id": "b0000000-0000-0000-0000-000000000001", "p_count": 25}).execute()
sb.rpc("run_spike_check", {}).execute()    # -> alert for Maria Reyes, linked to her town hall speech
sb.rpc("clear_demo_data", {}).execute()    # reset
```

**Incident files**
```python
digest = hashlib.sha256(file_bytes).hexdigest()
sb.storage.from_("incident-files").upload(path, file_bytes, {"content-type": mime})
sb.table("incident_files").insert({"incident_id": iid, "file_path": path, "file_kind": "voice_note",
    "mime_type": mime, "size_bytes": len(file_bytes), "sha256": digest}).execute()
# viewing: short-lived link, never a public URL
url = sb.storage.from_("incident-files").create_signed_url(path, 600)["signedURL"]
```
Both storage buckets are private. Only the backend can read or write them.

**Dashboard / government stats:** `select * from report_daily_stats`. This gives counts by day, country, platform and category, with no message text and no duplicates.

## 4. Demo data you can use right away

| What | ID |
|---|---|
| Maria Reyes (fictional minister, PH) | `b0000000-0000-0000-0000-000000000001` |
| Asha Verma (fictional MP, IN) | `b0000000-0000-0000-0000-000000000002` |
| Demo Women's Rights Network (verified) | `a0000000-0000-0000-0000-000000000001` |
| UN Women PH office (demo, verified, Reyes's org) | `a0000000-0000-0000-0000-000000000002` |
| Demo Community Collective IN (verified, Verma's org) | `a0000000-0000-0000-0000-000000000003` |
| Unverified Test Group | `a0000000-0000-0000-0000-000000000004` |

For the extension demo page: English phrases from the guide ("#Presstitute", "everyone knows how she got that seat 🍆🔥", "found where she lives"...) are real entries. Non-English slurs are **placeholders** like `PLACEHOLDER_TL_SLUR_01`, so put those tokens on the test page.

The lexicon also includes 2 pending entries (to show the review queue) and 1 rejected "poisoning attempt" ("sunflower"), which is useful when judges ask about trolls.

## 5. Open points for the team

1. **Languages vs countries don't line up yet.** Our classification doc demos English, Indonesian, Tagalog, Hindi and Vietnamese, but the legal guide covers PH, AU, FJ, IN and PK. Indonesia and Vietnam have no legal pack, and Fiji and Pakistan have no language entries beyond placeholders. Both are in the database, so we only need to choose what to show in the demo.
2. **The Philippines "where to report" link** in our guide points to cybersecurityintelligence.com, which isn't an official PNP-ACG site. It's worth replacing with an official page.
3. **Replace the placeholders** with partner-verified terms, and have native speakers check the non-English phrases.
4. `<WEBSITE_LINK>` in `next_steps` needs the real website URL.
5. **Manipulated text** is detected by the AI, not the lexicon, so it has no lexicon entries. That's expected.

## 6. Privacy notes (for the pitch)

- Reports store the reporter's **role** only. `reporter_id` is empty unless they're logged in.
- Events store the **city only**, never the venue. Event data never goes to the extension.
- Deleting a user account removes their profile. Their past reports stay but are no longer linked to them. A leader's incidents and file records are deleted when her leader record is deleted (right to delete, per the Philippines Data Privacy Act 2012). The backend must also delete the stored files from the bucket, because the database can't do that by itself.
- Storage files are private, and viewing uses links that expire after 10 minutes.
