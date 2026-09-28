# Kalasag website and API

The website is the partner workspace for Kalasag. It receives evidence from the browser extension, maintains the community-validated lexicon, puts unverified reports in front of reviewers, and turns approved reports into trends and early-warning signals.

It is a deliberately small Python 3.9+ application with no frontend build step. It runs locally by default and can use Supabase when a team needs a shared workspace.

## What partners use it for

### Evidence, reports, and incidents

The **Reports** workspace holds evidence saved from the extension: the source URL, platform, matched and surrounding text, source type, target leader when recognized, and an optional screenshot. Each screenshot is SHA-256 fingerprinted when it is stored. This gives a partner a stable record to support their own platform report, legal consultation, or complaint process; Kalasag does not lodge those complaints automatically.

The **Incidents** workspace records a written incident, its date, witnesses, and up to ten optional files such as photos or voice notes. Reports and incidents are separate: an online report captures a specific piece of content; an incident records a broader event.

### A living, reviewed lexicon

The **Word database** is where a community member or partner proposes a term. A submission includes the term, language, country, explanation, and submitter. If `ANTHROPIC_API_KEY` is configured, the server can draft a meaning, category, severity, spelling variants, and context note; otherwise it creates a basic draft. A human reviewer edits it, then approves or rejects it.

Only approved entries are returned from `GET /api/lexicon`, which means the extension’s local matching list is reviewed rather than an unmoderated stream of suggestions. Each entry carries a context note so a familiar word is not treated as harmful in every setting.

### Review before patterns are counted

An extension report with an approved lexicon entry is accepted immediately because the matched term was previously reviewed. AI-only findings and text a person highlights themselves are **pending**: the reviewer checks the screenshot, context, original page, category, and leader before approving or rejecting them. Only approved reports contribute to reports lists, trends, or alerts.

### Trends and early warning

The **Trends** view groups approved reports by date, leader, detailed/broad category, and platform. It compares the current week with the preceding one to show rising narratives.

An alert fires for a leader when both conditions hold:

- at least **5** approved reports mention her in the previous 24 hours; and
- that count is at least **3×** her average daily count over the previous seven days.

Kalasag permits at most one alert per leader every six hours. The dashboard can inject fictional reports to demonstrate this flow. The thresholds are `SPIKE_MIN`, `SPIKE_MULTIPLIER`, and `ALERT_COOLDOWN_HOURS` in [`app.py`](app.py).

## Run locally

Install the sole Python dependency and start the server:

```bash
cd website
python -m pip install -r requirements.txt
python app.py
```

Open:

- [http://localhost:8000](http://localhost:8000) — partner dashboard;
- [http://localhost:8000/test-feed](http://localhost:8000/test-feed) — fictional social-feed fixture;
- [http://localhost:8000/test-article](http://localhost:8000/test-article) — fictional article/comment fixture.

With no configuration, data lives only on this computer:

| Data | Local backend |
|---|---|
| Structured records | `website/kalasag.db` (SQLite) |
| Screenshots and incident files | `website/evidence/` |

The first run seeds fictional leaders, approved and pending terms, and a quiet reporting history so the dashboard and spike simulation have something to show.

## Use Supabase for a shared workspace

1. Create a Supabase project and run [`../database/schema.sql`](../database/schema.sql) in **SQL Editor**. The schema is destructive: it removes older Kalasag tables before creating them.
2. Copy `.env.example` to `.env` in this folder.
3. Set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in `.env`, then restart `python app.py`.

The startup message will say `Database: Supabase (shared, online)`. The extension still speaks only to this website API; it never receives the Supabase secret or queries Supabase directly. In the Supabase mode, evidence is placed in the private `evidence` storage bucket created by the schema.

`ANTHROPIC_API_KEY` is optional and powers AI drafts for new lexicon submissions and alert summaries. It is separate from the browser extension’s OpenAI-compatible classification connection. Without it, term drafts and alert summaries use the built-in non-AI fallback.

If an existing Supabase deployment was created before report review was introduced, run [`../database/migrations/002_report_review.sql`](../database/migrations/002_report_review.sql) once. A freshly applied `schema.sql` already includes those fields.

## How it works

```text
Browser extension
  ├─ downloads approved country/language lexicon entries
  ├─ saves a visible-tab screenshot, text, URL, platform, and source metadata
  └─ POST /api/reports
           │
           ▼
app.py
  ├─ stores files and their SHA-256 fingerprints
  ├─ identifies a registered leader from name variants in the text
  ├─ marks the report approved or pending based on its source
  ├─ evaluates the per-leader spike rule for approved reports
  └─ exposes dashboard data and reporting/legal guidance
           │
           ▼
SQLite (local) or Supabase + private storage (shared)
```

The server is a `ThreadingHTTPServer` bound to `127.0.0.1:8000`. It provides JSON responses and allows cross-origin requests so a locally loaded browser extension can call it. The dashboard is a static page served by the same process and consumes those API endpoints.

## API used by the extension

Base URL: `http://localhost:8000`. Requests and responses are JSON.

### Download the approved word list

`GET /api/lexicon?country=PH&languages=tl,en`

The response contains a version timestamp, count, and approved entries. An entry includes its term, variants, meaning, language/country, detailed and broad categories, severity, and context note. Extensions should refresh when the version changes and match both the term and variants case-insensitively.

### Save a report

`POST /api/reports`

```json
{
  "source": "word_list",
  "lexicon_id": 1,
  "matched_text": "1yak1n",
  "context_text": "the surrounding post or comment",
  "category": "emotional_unfitness",
  "url": "https://example.org/post/1",
  "platform": "facebook",
  "reporter_role": "ally",
  "country": "PH",
  "screenshot_b64": "data:image/png;base64,..."
}
```

Send `matched_text` or `lexicon_id`. `source` may be `word_list`, `ai`, or `highlight`. The server derives the category from `lexicon_id` when needed, tries to identify a registered leader in the text, saves and fingerprints the screenshot, and returns the report ID, status, leader ID, fingerprint, and any triggered alert.

### Get legal and platform-reporting guidance

`GET /api/legal-info?country=PH&platform=facebook`

The current demo provides Philippines and Australia information, plus reporting steps for Facebook, X, TikTok, and a general fallback. The extension has a small offline fallback for the same purpose.

## Dashboard API reference

| Method | Endpoint | Use |
|---|---|---|
| `GET` | `/api/status` | Runtime capabilities, category/language lists, and pending count. |
| `GET` / `POST` | `/api/submissions` | List terms by review status or submit a new term. |
| `POST` | `/api/submissions/{id}/approve` | Approve a term with reviewer edits. |
| `POST` | `/api/submissions/{id}/reject` | Reject a term. |
| `GET` | `/api/reports?status=pending` | List reports by `pending`, `approved`, or `rejected` status. |
| `POST` | `/api/reports/{id}/approve` | Approve a pending report; accepts reviewer, category, and optional leader ID. |
| `POST` | `/api/reports/{id}/reject` | Reject a pending report; requires reviewer. |
| `GET` / `POST` | `/api/leaders` | List leaders with events/report counts or add a leader and optional event. |
| `GET` | `/api/alerts` | Read early-warning alerts. |
| `POST` | `/api/alerts/{id}/seen` | Mark an alert seen. |
| `GET` / `POST` | `/api/incidents` | List or create incident records. |
| `GET` | `/api/stats?days=14` | Trend, narrative, platform, leader, and alert aggregates. |
| `POST` | `/api/demo/inject` | Add fictional reports to demonstrate a spike. |
| `POST` | `/api/demo/reset` | Remove injected demo reports and alerts. |

## Categories

The lexicon and reports use a detailed category and map it to a broad category from the project guide.

| Broad category | Detailed categories |
|---|---|
| Gender hate speech | Sexualized slur, too-emotional narrative, family-role attack, appearance attack, demeaning women as a group, threat |
| Gendered disinformation | Competence/puppet narrative, fabricated scandal |
| Not yet classified | Needs classification |

The mapping lives in `BROAD_OF` near the top of [`app.py`](app.py).

## Demo and production boundary

The dashboard’s people, events, reports, and placeholder slur are fictional. The current server has no authentication or role enforcement, uses a local HTTP development setup, and exposes a permissive CORS policy for extension testing. Do not treat it as a live vault for sensitive evidence.

Before a real deployment, add authenticated user and organization roles, authorization for reports/evidence/incidents, HTTPS, production secret management, consent and retention controls, backup and incident-response processes, legal review of jurisdictional guidance, and a privacy/security assessment. See [the database README](../database/README.md) for the data model and storage boundary.
