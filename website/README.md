# Kalasag: data-gathering website (demo)

Runs on plain Python 3.9+, nothing to install.

## Run it

```bash
cd website
python app.py
```

Then open:

- http://localhost:8000 for the partner dashboard (trends, word database, alerts, reports, incidents)
- http://localhost:8000/test-feed and http://localhost:8000/test-article to test the extension on

## Where the data is stored

| Setup | Data lives in | Who sees it |
|---|---|---|
| `website/.env` has the Supabase keys | Supabase (online) | Everyone on the team, from any computer |
| No `.env` | `website/kalasag.db` (a local file) | Only this computer |

**To use Supabase:**
1. The first time only, run `../database/schema.sql` in Supabase (**SQL Editor → New query → Run**).
2. Copy `.env.example` to `.env` in this folder and paste the **secret** key from **Project Settings → API Keys**.
3. Run `python app.py`. The terminal should say `Database: Supabase (shared, online)`.

The first start adds the demo data (fictional leaders, Tagalog and English words, two quiet weeks of reports).

`.env` is git-ignored. Never commit it and never share the secret key in chat.

**AI (optional):** add `ANTHROPIC_API_KEY` to `.env` to turn on AI drafting of new words and AI alert summaries. Without it, everything still works and drafts are filled in by hand.

**Start over with fresh demo data:** local file: stop the server, delete `kalasag.db` and `evidence/`. Supabase: run `schema.sql` again, then restart.

## Categories

Every report has a detailed category (what the extension and the word list use) and a broad category from the team's guide:

| Broad category | Detailed categories |
|---|---|
| Gender hate speech | Sexualized slur, "Too emotional to lead", "Belongs at home", Appearance, Demeaning women as a group, Threat |
| Gendered disinformation | "Puppet" or incompetence, Fabricated scandal |
| Manipulated text or context | Found by the AI check (e.g. fabricated quotes) |

Change the mapping in `BROAD_OF` at the top of `app.py`.

## Demo script

1. Trends: the dashboard opens here. Show reports per day, the rising narratives and the leaders table.
2. Word database: suggest a new term, show the AI draft, edit it, approve it. It now appears in the JSON feed.
3. Open the test feed with the extension on. Flagged posts get highlighted; fair criticism does not.
4. Click "Save as evidence" in the extension. The report appears on the Reports tab with its fingerprint.
5. Leaders and alerts: click "Simulate a spike". The alert appears with a summary.
6. Incidents: record an incident with a photo or voice note.

## API for the extension

All requests and responses are JSON. Base URL: `http://localhost:8000`.
Add `"http://localhost:8000/*"` to `host_permissions` in the extension manifest.

### Download the word list

`GET /api/lexicon?country=PH&languages=tl,en`

```json
{
  "version": "2026-09-26T14:41:40Z",
  "count": 7,
  "entries": [
    {
      "id": 1, "term": "iyakin", "variants": ["1yak1n", "iyak1n"],
      "language": "tl", "country": "PH",
      "meaning": "Crybaby. Used to paint a woman leader as too emotional to govern.",
      "category": "emotional_unfitness",
      "category_label": "False 'too emotional to lead' narrative",
      "severity": "medium",
      "context_note": "Everyday word. Only harmful when aimed at a woman leader's capacity to lead."
    }
  ]
}
```

Cache it and re-download when `version` changes. Match `term` and every item in `variants`, case-insensitive.

### Save a report ("Save as evidence")

`POST /api/reports`

```json
{
  "lexicon_id": 1,
  "matched_text": "1yak1n",
  "context_text": "the full post text around the match",
  "url": "https://...",
  "platform": "facebook",
  "reporter_role": "target | ally | organization",
  "country": "PH",
  "screenshot_b64": "data:image/png;base64,..."
}
```

Only `matched_text` or `lexicon_id` is required. The server works out which registered leader the post is about from `context_text`, fingerprints the screenshot, and checks for a spike.
Response: `{ "id", "created_at", "leader_id", "screenshot_sha256", "alert_triggered" }`.

A screenshot can be taken in the extension's background script with `chrome.tabs.captureVisibleTab()`, which returns a data URL you can send as-is.

### Legal info and reporting steps for the pop-up

`GET /api/legal-info?country=PH&platform=facebook` returns laws, authorities, a threat note and step-by-step reporting instructions. Countries: `PH`, `AU`. Platforms: `facebook`, `x`, `tiktok`, `other`.

## Other endpoints (used by the dashboard)

| Method | Path | What it does |
|---|---|---|
| GET | /api/stats?days=14 | Numbers for the Trends page: reports per day per leader, narratives, broad categories, platforms, leaders |
| GET | /api/status | Whether AI is on; category, language and severity lists |
| GET | /api/submissions?status=pending | Review queue (also `approved`, `rejected`) |
| POST | /api/submissions | Suggest a term: `term, language, country, explanation, submitted_by` |
| POST | /api/submissions/{id}/approve | Approve with edits: `reviewer, meaning, category, severity, variants, context_note` |
| POST | /api/submissions/{id}/reject | Reject: `reviewer` |
| GET | /api/reports | Latest reports |
| GET / POST | /api/leaders | List or register leaders and events |
| GET | /api/alerts | Alerts, newest first |
| POST | /api/alerts/{id}/seen | Mark an alert as seen |
| GET / POST | /api/incidents | List or save incidents (`files: [{name, data_b64}]`) |
| POST | /api/demo/inject | Add fake reports: `leader_id, count` |
| POST | /api/demo/reset | Remove demo reports and all alerts |

## Expert review of reports

- Reports that matched a word from the verified word list count straight away.
- Text someone highlighted with **Report to Kalasag**, and posts only the AI found, arrive as **pending**. They appear under **Waiting for review** on the Reports tab, with the screenshot, the reporter's note and a link to the original page.
- An expert can correct the category and the leader, then **Approve** (it counts in Trends, alerts and the reports list) or **Reject**.
- Endpoints: `GET /api/reports?status=pending` and `POST /api/reports/{id}/approve` or `/reject` with `{"reviewer": "...", "category": "...", "leader_id": 1}`.
- Supabase tables created before this feature need `database/migration_002_report_review.sql` run once in the SQL Editor.

## Spike rule

An alert fires when a leader has at least 5 reports in the last 24 hours and at least 3 times her average daily count over the previous 7 days. At most one alert per leader every 6 hours. Change `SPIKE_MIN`, `SPIKE_MULTIPLIER` and `ALERT_COOLDOWN_HOURS` at the top of `app.py`.

## Before this is used for real

This is a local demo. Real use would need login and roles (only verified partners approve words; only a leader and her team see her events and incidents), encrypted storage for incidents, HTTPS, compliance with the Philippines Data Privacy Act of 2012, and legal text checked by a lawyer. All leaders, posts and the placeholder slur in the seed data are fictional.
