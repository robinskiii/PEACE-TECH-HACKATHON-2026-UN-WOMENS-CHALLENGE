#!/usr/bin/env python3
"""
Kalasag demo backend: word database, reports, early-warning alerts, incident evidence.

Uses only the Python standard library, so there is nothing to install.
Run:   python app.py
Open:  http://localhost:8000          (dashboard)
       http://localhost:8000/test-feed (fake social feed to test the extension on)

Optional AI features (drafting word entries, alert summaries):
       set ANTHROPIC_API_KEY in your terminal before running.
"""
import base64
import hashlib
import json
import os
import re
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HOST, PORT = "127.0.0.1", 8000
BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE, "kalasag.db")
EVIDENCE_DIR = os.path.join(BASE, "evidence")
STATIC_DIR = os.path.join(BASE, "static")

API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
MODEL = "claude-sonnet-5"

# Spike rule: alert when the last 24h has at least SPIKE_MIN reports about a leader
# AND at least SPIKE_MULTIPLIER times her average daily count over the 7 days before.
SPIKE_MIN = 5
SPIKE_MULTIPLIER = 3
ALERT_COOLDOWN_HOURS = 6

CATEGORIES = {
    "sexualized_slur": "Sexualized slur",
    "emotional_unfitness": "False 'too emotional to lead' narrative",
    "family_role": "'Belongs at home' / family-role attack",
    "appearance": "Attack on appearance",
    "competence_undermining": "'Puppet' or incompetence narrative",
    "fabricated_scandal": "Fabricated scandal",
    "threat": "Threat of violence",
    "misogynistic_generalization": "Demeaning women as a group",
    "unclassified": "Needs classification",
}
SEVERITIES = ["low", "medium", "high"]
LANGUAGES = {"tl": "Tagalog", "ceb": "Cebuano", "ilo": "Ilocano", "en": "English"}

LEGAL_INFO = {
    "PH": {
        "country": "Philippines",
        "laws": [
            {"name": "Safe Spaces Act (RA 11313)",
             "summary": "Covers gender-based online sexual harassment, including misogynistic, "
                        "sexist or sexual remarks and threats made online."},
            {"name": "Cybercrime Prevention Act (RA 10175)",
             "summary": "Covers cyber libel and other offences committed through computer systems."},
        ],
        "authorities": [
            {"name": "PNP Anti-Cybercrime Group", "url": "https://acg.pnp.gov.ph"},
            {"name": "NBI Cybercrime Division", "url": "https://nbi.gov.ph"},
        ],
        "threat_note": "If there is a threat to someone's safety, contact the police (911) first.",
    },
    "AU": {
        "country": "Australia",
        "laws": [
            {"name": "Online Safety Act 2021 (Adult Cyber Abuse Scheme)",
             "summary": "eSafety can order removal of seriously harmful online abuse aimed at an "
                        "Australian adult, after it has been reported to the platform."},
        ],
        "authorities": [
            {"name": "eSafety Commissioner", "url": "https://www.esafety.gov.au/report"},
        ],
        "threat_note": "If someone is in immediate danger, call 000.",
    },
}
PLATFORM_STEPS = {
    "facebook": ["Click the three dots (…) on the post.", "Choose 'Report post'.",
                 "Pick the reason that fits best (harassment, hate speech, false information).",
                 "Save the evidence here first, in case the post is deleted."],
    "x": ["Click the three dots (…) on the post.", "Choose 'Report post'.",
          "Select 'Hate' or 'Abuse and harassment' and follow the prompts."],
    "tiktok": ["Press and hold the video, or tap the share arrow.", "Tap 'Report'.",
               "Choose 'Hate and harassment' and submit."],
    "other": ["Look for a 'Report' option near the post or comment.",
              "Save the evidence here first, in case the content is deleted."],
}


# ---------------------------------------------------------------- helpers

def now_utc():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def row_to_dict(row, json_fields=()):
    d = dict(row)
    for f in json_fields:
        if f in d and isinstance(d[f], str):
            try:
                d[f] = json.loads(d[f])
            except json.JSONDecodeError:
                d[f] = []
    return d


def as_list(value):
    """Accept a list or a comma-separated string; return a clean list of strings."""
    if value is None:
        return []
    if isinstance(value, str):
        value = value.split(",")
    return [str(v).strip() for v in value if str(v).strip()]


def require(body, *fields):
    missing = [f for f in fields if not str(body.get(f, "")).strip()]
    if missing:
        raise ValueError("Missing required field(s): " + ", ".join(missing))


def save_b64_file(data_b64, prefix, original_name="file.bin"):
    """Decode a base64 (or data: URL) file, store it, and return (path, sha256)."""
    if "," in data_b64 and data_b64.strip().startswith("data:"):
        data_b64 = data_b64.split(",", 1)[1]
    raw = base64.b64decode(data_b64)
    digest = hashlib.sha256(raw).hexdigest()
    ext = os.path.splitext(original_name)[1].lower()[:8] or ".bin"
    name = f"{prefix}_{digest[:16]}{ext}"
    with open(os.path.join(EVIDENCE_DIR, name), "wb") as fh:
        fh.write(raw)
    return name, digest


def leet_variants(term):
    """Simple spelling tricks people use to dodge moderation. Used when AI is off."""
    t = term.lower()
    swaps = {"a": "4", "e": "3", "i": "1", "o": "0", "s": "5"}
    out = {"".join(swaps.get(c, c) for c in t),
           t.replace("i", "1"),
           t.replace("a", "@"),
           " ".join(t.replace(" ", "")),
           ".".join(t.replace(" ", ""))}
    out.discard(t)
    return sorted(out)[:5]


# ---------------------------------------------------------------- AI

def call_claude(system, user_text, max_tokens=700):
    """Returns the model's text, or None if there's no key or the call fails."""
    if not API_KEY:
        return None
    payload = json.dumps({
        "model": MODEL,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user_text}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=payload, method="POST",
        headers={"x-api-key": API_KEY, "anthropic-version": "2023-06-01",
                 "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            data = json.loads(resp.read())
        return "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    except urllib.error.HTTPError as e:
        print("AI call failed:", e.code, e.read()[:300])
    except Exception as e:  # network down, timeout, etc.
        print("AI call failed:", e)
    return None


def parse_json_loose(text):
    if not text:
        return None
    text = re.sub(r"```(?:json)?", "", text)
    match = re.search(r"\{.*\}", text, re.S)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError:
        return None


ENRICH_SYSTEM = f"""You help a verified civil-society reviewer build a database of terms used
in gendered disinformation and online abuse against women leaders in Asia and the Pacific.
A community member has submitted a term with a rough explanation. Draft a clean database entry.
A human reviewer who speaks the language will check and correct your draft before it is used.

Return ONLY a JSON object, no other text:
{{"meaning": "one or two plain sentences in English explaining what the term means and how it is used",
 "category": one of {list(CATEGORIES.keys())},
 "severity": one of {SEVERITIES},
 "variants": ["up to 6 spelling variants people use to evade moderation, e.g. letter swaps, spacing, common misspellings"],
 "context_note": "when the term is harmful vs. when it is neutral everyday use, so the extension avoids false flags"}}

If you are unsure what the term means, say so in "meaning" and use category "unclassified".
Do not invent claims about real people."""

SUMMARY_SYSTEM = """You write short, calm alerts for a woman leader and the organization supporting her.
You receive recent reports of hostile or false content about her. Write 2-3 neutral sentences:
what narrative or tactic is rising, roughly how much, and on which platforms.
Do not repeat slurs or insults word for word; describe them by type instead.
Do not speculate about who is behind it. Plain text only."""


def ai_draft_entry(term, language, country, raw_text):
    reply = call_claude(ENRICH_SYSTEM,
                        f"Term: {term}\nLanguage: {LANGUAGES.get(language, language)}\n"
                        f"Country: {country}\nCommunity member's explanation:\n{raw_text}")
    draft = parse_json_loose(reply)
    if draft:
        category = draft.get("category") if draft.get("category") in CATEGORIES else "unclassified"
        severity = draft.get("severity") if draft.get("severity") in SEVERITIES else "medium"
        return {"meaning": str(draft.get("meaning", "")).strip(), "category": category,
                "severity": severity, "variants": as_list(draft.get("variants"))[:6],
                "context_note": str(draft.get("context_note", "")).strip(), "ai_drafted": 1}
    # Fallback when AI is off or failed: the reviewer fills things in by hand.
    return {"meaning": raw_text.strip(), "category": "unclassified", "severity": "medium",
            "variants": leet_variants(term), "context_note": "", "ai_drafted": 0}


# ---------------------------------------------------------------- database setup

SCHEMA = """
CREATE TABLE IF NOT EXISTS lexicon (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL, variants TEXT NOT NULL DEFAULT '[]',
    language TEXT NOT NULL, country TEXT NOT NULL,
    meaning TEXT, category TEXT NOT NULL DEFAULT 'unclassified',
    severity TEXT NOT NULL DEFAULT 'medium', context_note TEXT,
    status TEXT NOT NULL DEFAULT 'pending',          -- pending | approved | rejected
    raw_submission TEXT, submitted_by TEXT, approved_by TEXT,
    ai_drafted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS leaders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, name_variants TEXT NOT NULL DEFAULT '[]',
    organization TEXT, alert_contact TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    leader_id INTEGER NOT NULL REFERENCES leaders(id),
    name TEXT NOT NULL, event_date TEXT, location TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL, url TEXT, platform TEXT,
    lexicon_id INTEGER REFERENCES lexicon(id),
    matched_text TEXT, context_text TEXT, category TEXT,
    reporter_role TEXT, country TEXT,
    leader_id INTEGER REFERENCES leaders(id),
    screenshot_file TEXT, screenshot_sha256 TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    leader_id INTEGER NOT NULL REFERENCES leaders(id),
    created_at TEXT NOT NULL, count_24h INTEGER, baseline_per_day REAL,
    summary TEXT, seen INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    leader_id INTEGER REFERENCES leaders(id),
    created_at TEXT NOT NULL, occurred_at TEXT,
    description TEXT NOT NULL, witnesses TEXT,
    files TEXT NOT NULL DEFAULT '[]'                  -- [{name, file, sha256}]
);
"""

SEED_TERMS = [
    # (term, variants, lang, meaning, category, severity, context_note)
    ("iyakin", ["1yak1n", "iyak1n", "iyak!n", "i y a k i n"], "tl",
     "Crybaby. Used to paint a woman leader as too emotional to govern.",
     "emotional_unfitness", "medium",
     "Everyday word. Only harmful when aimed at a woman leader's capacity to lead."),
    ("too emotional to lead", ["too emotional to govern", "2 emotional to lead"], "en",
     "Claims a woman is unfit for office because of her emotions.",
     "emotional_unfitness", "medium", "Flag when directed at a named woman leader."),
    ("leaked video", ["leaked vid", "l3aked video", "scandal video"], "en",
     "A common hook for fabricated sexual scandals, usually paired with a link.",
     "fabricated_scandal", "high",
     "Harmful when attached to a woman leader's name. Warn users not to click the link."),
    ("bumalik ka na sa kusina", ["balik kusina", "bumalik sa kusina"], "tl",
     "'Go back to the kitchen.' Tells a woman leader her place is at home.",
     "family_role", "medium", "Almost always used as an attack in a political context."),
    ("should be home with her kids", ["should be at home with her kids", "go home to her kids"], "en",
     "Says a woman leader should leave public life for childcare.",
     "family_role", "medium", "Flag when directed at a named woman leader."),
    ("puppet lang ng asawa", ["puppet ng asawa", "papet lang ng asawa"], "tl",
     "'Just her husband's puppet.' Claims her decisions are really made by a man.",
     "competence_undermining", "medium", "Common in Taglish comments on local officials."),
    ("zelvira", ["z3lvira", "zel vira", "zelv1ra"], "tl",
     "Placeholder for a real sexualized slur, for the demo only. Replace with partner-verified terms.",
     "sexualized_slur", "high", "Demo placeholder."),
]

SEED_PENDING = [
    ("bayaran ng China", "tl", "PH",
     "People keep commenting this on Mayor Reyes' posts, saying she is paid by China. "
     "It started after her speech on the port project.", "Barangay youth council, Iloilo",
     {"meaning": "'Paid by China.' Accuses a leader of being secretly funded by a foreign government, "
                 "with no evidence offered.",
      "category": "fabricated_scandal", "severity": "medium",
      "variants": ["bayaran ng tsina", "bayad ng China", "b4yaran ng China"],
      "context_note": "Also used against men. Flag when combined with a woman leader's name and no source.",
      "ai_drafted": 0}),
    ("walang alam", "tl", "PH",
     "Used under Senator Dela Cruz's videos as 'Mrs. Walang Alam', meaning she knows nothing, "
     "always about her being a woman.", "Women in Governance Network",
     None),
]


def init_db():
    os.makedirs(EVIDENCE_DIR, exist_ok=True)
    with db() as conn:
        conn.executescript(SCHEMA)
        if conn.execute("SELECT COUNT(*) FROM lexicon").fetchone()[0]:
            return
        print("Seeding demo data (fictional leaders and placeholder terms)...")
        ts = iso(now_utc())
        for term, variants, lang, meaning, cat, sev, note in SEED_TERMS:
            conn.execute(
                "INSERT INTO lexicon (term, variants, language, country, meaning, category, severity,"
                " context_note, status, submitted_by, approved_by, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?, 'approved', 'seed', 'Demo partner org', ?, ?)",
                (term, json.dumps(variants), lang, "PH", meaning, cat, sev, note, ts, ts))
        for term, lang, country, raw, who, draft in SEED_PENDING:
            draft = draft or {"meaning": raw, "category": "unclassified", "severity": "medium",
                              "variants": leet_variants(term), "context_note": "", "ai_drafted": 0}
            conn.execute(
                "INSERT INTO lexicon (term, variants, language, country, meaning, category, severity,"
                " context_note, status, raw_submission, submitted_by, ai_drafted, created_at, updated_at)"
                " VALUES (?,?,?,?,?,?,?,?, 'pending', ?,?,?,?,?)",
                (term, json.dumps(draft["variants"]), lang, country, draft["meaning"], draft["category"],
                 draft["severity"], draft["context_note"], raw, who, draft["ai_drafted"], ts, ts))

        leaders = [
            ("Mayor Liza Reyes", ["Liza Reyes", "Mayor Reyes", "Mayora Liza", "Liza"],
             "UN Women Philippines (demo)", "alerts@example.org",
             ("Town hall on the port project", 5, "City hall")),
            ("Sen. Carmen Dela Cruz", ["Carmen Dela Cruz", "Dela Cruz", "Sen. Dela Cruz", "Senadora Carmen"],
             "Women in Governance Network (demo)", "team@example.org",
             ("Maternal health bill hearing", 12, "Senate, Pasay")),
        ]
        for name, variants, org, contact, (ev_name, in_days, loc) in leaders:
            cur = conn.execute(
                "INSERT INTO leaders (name, name_variants, organization, alert_contact, created_at)"
                " VALUES (?,?,?,?,?)", (name, json.dumps(variants), org, contact, ts))
            conn.execute(
                "INSERT INTO events (leader_id, name, event_date, location, created_at) VALUES (?,?,?,?,?)",
                (cur.lastrowid, ev_name, (now_utc() + timedelta(days=in_days)).strftime("%Y-%m-%d"), loc, ts))

        # A quiet baseline of about one report a day last week, so the spike stands out.
        for leader_id in (1, 2):
            for day in range(2, 9):
                when = iso(now_utc() - timedelta(days=day, hours=3 * leader_id))
                conn.execute(
                    "INSERT INTO reports (created_at, url, platform, lexicon_id, matched_text, category,"
                    " reporter_role, country, leader_id) VALUES (?,?,?,?,?,?,?,?,?)",
                    (when, "https://example.com/post/baseline", "facebook", 1, "iyakin",
                     "emotional_unfitness", "ally", "PH", leader_id))


# ---------------------------------------------------------------- core logic

def find_leader(conn, *texts):
    blob = " ".join(t for t in texts if t).lower()
    if not blob:
        return None
    for row in conn.execute("SELECT id, name, name_variants FROM leaders"):
        names = [row["name"]] + json.loads(row["name_variants"] or "[]")
        # Longest names first so "Mayor Reyes" wins over a short nickname.
        for n in sorted(names, key=len, reverse=True):
            if len(n) >= 4 and n.lower() in blob:
                return row["id"]
    return None


def check_spike(conn, leader_id):
    """Create an alert if reports about this leader have spiked. Returns the alert or None."""
    now = now_utc()
    since_24h, since_8d = iso(now - timedelta(hours=24)), iso(now - timedelta(days=8))
    count = conn.execute("SELECT COUNT(*) FROM reports WHERE leader_id=? AND created_at>=?",
                         (leader_id, since_24h)).fetchone()[0]
    prev = conn.execute("SELECT COUNT(*) FROM reports WHERE leader_id=? AND created_at>=? AND created_at<?",
                        (leader_id, since_8d, since_24h)).fetchone()[0]
    baseline = prev / 7.0
    if count < SPIKE_MIN or count < SPIKE_MULTIPLIER * max(baseline, 1.0):
        return None
    recent = conn.execute("SELECT 1 FROM alerts WHERE leader_id=? AND created_at>=?",
                          (leader_id, iso(now - timedelta(hours=ALERT_COOLDOWN_HOURS)))).fetchone()
    if recent:
        return None

    rows = conn.execute(
        "SELECT r.platform, r.category, r.context_text, r.matched_text FROM reports r"
        " WHERE r.leader_id=? AND r.created_at>=? ORDER BY r.created_at DESC LIMIT 40",
        (leader_id, since_24h)).fetchall()
    leader = conn.execute("SELECT name FROM leaders WHERE id=?", (leader_id,)).fetchone()
    lines = [f"- [{r['platform']}] category={r['category']}: {(r['context_text'] or r['matched_text'] or '')[:200]}"
             for r in rows]
    summary = call_claude(SUMMARY_SYSTEM,
                          f"Leader: {leader['name']}\nReports in the last 24 hours: {count} "
                          f"(normal is about {baseline:.1f} per day)\n" + "\n".join(lines), max_tokens=250)
    if not summary:
        by_cat = {}
        for r in rows:
            by_cat[r["category"]] = by_cat.get(r["category"], 0) + 1
        top = sorted(by_cat.items(), key=lambda kv: -kv[1])
        parts = ", ".join(f"{CATEGORIES.get(c, c).lower()} ({n})" for c, n in top[:3])
        platforms = sorted({r["platform"] or "unknown" for r in rows})
        summary = (f"{count} reports in the last 24 hours, against a usual {baseline:.1f} per day. "
                   f"Most common: {parts}. Platforms: {', '.join(platforms)}.")
    ts = iso(now)
    cur = conn.execute("INSERT INTO alerts (leader_id, created_at, count_24h, baseline_per_day, summary)"
                       " VALUES (?,?,?,?,?)", (leader_id, ts, count, round(baseline, 2), summary.strip()))
    print(f"ALERT for leader {leader_id}: {count} reports in 24h")
    return {"id": cur.lastrowid, "leader_id": leader_id, "count_24h": count, "summary": summary.strip()}


# ---------------------------------------------------------------- route handlers
# Each returns (status_code, json_payload).

def api_status(q, body):
    return 200, {"ai_enabled": bool(API_KEY), "model": MODEL if API_KEY else None,
                 "categories": CATEGORIES, "languages": LANGUAGES, "severities": SEVERITIES}


def api_lexicon(q, body):
    """What the extension downloads. Only approved entries."""
    sql, args = "SELECT * FROM lexicon WHERE status='approved'", []
    if q.get("country"):
        sql += " AND country=?"
        args.append(q["country"].upper())
    langs = as_list(q.get("languages"))
    if langs:
        sql += f" AND language IN ({','.join('?' * len(langs))})"
        args += langs
    with db() as conn:
        rows = conn.execute(sql + " ORDER BY term", args).fetchall()
        version = conn.execute("SELECT MAX(updated_at) FROM lexicon WHERE status='approved'").fetchone()[0]
    entries = [{k: e[k] for k in ("id", "term", "variants", "language", "country", "meaning",
                                  "category", "severity", "context_note")}
               | {"category_label": CATEGORIES.get(e["category"], e["category"])}
               for e in (row_to_dict(r, ["variants"]) for r in rows)]
    return 200, {"version": version, "count": len(entries), "entries": entries}


def api_submissions_list(q, body):
    status = q.get("status", "pending")
    with db() as conn:
        rows = conn.execute("SELECT * FROM lexicon WHERE status=? ORDER BY created_at DESC",
                            (status,)).fetchall()
    return 200, [row_to_dict(r, ["variants"]) for r in rows]


def api_submissions_create(q, body):
    require(body, "term", "language", "country", "explanation")
    term = body["term"].strip()
    lang, country = body["language"].strip(), body["country"].strip().upper()
    raw = body["explanation"].strip()
    draft = ai_draft_entry(term, lang, country, raw)
    ts = iso(now_utc())
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO lexicon (term, variants, language, country, meaning, category, severity,"
            " context_note, status, raw_submission, submitted_by, ai_drafted, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?, 'pending', ?,?,?,?,?)",
            (term, json.dumps(draft["variants"]), lang, country, draft["meaning"], draft["category"],
             draft["severity"], draft["context_note"], raw, body.get("submitted_by", "anonymous"),
             draft["ai_drafted"], ts, ts))
        row = conn.execute("SELECT * FROM lexicon WHERE id=?", (cur.lastrowid,)).fetchone()
    return 201, row_to_dict(row, ["variants"])


def api_submission_review(q, body, entry_id, decision):
    entry_id = int(entry_id)
    with db() as conn:
        row = conn.execute("SELECT * FROM lexicon WHERE id=?", (entry_id,)).fetchone()
        if not row:
            return 404, {"error": "No entry with that id."}
        if decision == "reject":
            conn.execute("UPDATE lexicon SET status='rejected', approved_by=?, updated_at=? WHERE id=?",
                         (body.get("reviewer", ""), iso(now_utc()), entry_id))
        else:
            require(body, "reviewer")
            category = body.get("category", row["category"])
            if category not in CATEGORIES or category == "unclassified":
                raise ValueError("Choose a category before approving.")
            severity = body.get("severity", row["severity"])
            if severity not in SEVERITIES:
                raise ValueError("Severity must be low, medium or high.")
            conn.execute(
                "UPDATE lexicon SET term=?, meaning=?, category=?, severity=?, variants=?, context_note=?,"
                " status='approved', approved_by=?, updated_at=? WHERE id=?",
                (body.get("term", row["term"]).strip(), body.get("meaning", row["meaning"]),
                 category, severity,
                 json.dumps(as_list(body["variants"]) if "variants" in body else json.loads(row["variants"])),
                 body.get("context_note", row["context_note"]), body["reviewer"], iso(now_utc()), entry_id))
        row = conn.execute("SELECT * FROM lexicon WHERE id=?", (entry_id,)).fetchone()
    return 200, row_to_dict(row, ["variants"])


def api_reports_create(q, body):
    """What the extension sends when the user clicks 'Save as evidence'."""
    if not (body.get("matched_text") or body.get("lexicon_id")):
        raise ValueError("Send matched_text or lexicon_id.")
    ts = iso(now_utc())
    with db() as conn:
        category = body.get("category")
        if body.get("lexicon_id") and not category:
            r = conn.execute("SELECT category FROM lexicon WHERE id=?", (body["lexicon_id"],)).fetchone()
            category = r["category"] if r else None
        leader_id = body.get("leader_id") or find_leader(conn, body.get("context_text"), body.get("matched_text"))
        shot_file = shot_hash = None
        if body.get("screenshot_b64"):
            shot_file, shot_hash = save_b64_file(body["screenshot_b64"], "report", "screenshot.png")
        cur = conn.execute(
            "INSERT INTO reports (created_at, url, platform, lexicon_id, matched_text, context_text, category,"
            " reporter_role, country, leader_id, screenshot_file, screenshot_sha256)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (ts, body.get("url"), (body.get("platform") or "other").lower(), body.get("lexicon_id"),
             body.get("matched_text"), (body.get("context_text") or "")[:2000], category or "unclassified",
             body.get("reporter_role"), (body.get("country") or "PH").upper(), leader_id, shot_file, shot_hash))
        alert = check_spike(conn, leader_id) if leader_id else None
    return 201, {"id": cur.lastrowid, "created_at": ts, "leader_id": leader_id,
                 "screenshot_sha256": shot_hash, "alert_triggered": alert}


def api_reports_list(q, body):
    limit = min(int(q.get("limit", 100)), 500)
    with db() as conn:
        rows = conn.execute(
            "SELECT r.*, l.name AS leader_name, x.term AS term FROM reports r"
            " LEFT JOIN leaders l ON l.id=r.leader_id LEFT JOIN lexicon x ON x.id=r.lexicon_id"
            " ORDER BY r.created_at DESC LIMIT ?", (limit,)).fetchall()
    return 200, [dict(r) for r in rows]


def api_leaders_list(q, body):
    since = iso(now_utc() - timedelta(hours=24))
    with db() as conn:
        leaders = []
        for r in conn.execute("SELECT * FROM leaders ORDER BY name"):
            d = row_to_dict(r, ["name_variants"])
            d["events"] = [dict(e) for e in conn.execute(
                "SELECT * FROM events WHERE leader_id=? ORDER BY event_date", (r["id"],))]
            d["reports_24h"] = conn.execute(
                "SELECT COUNT(*) FROM reports WHERE leader_id=? AND created_at>=?", (r["id"], since)).fetchone()[0]
            leaders.append(d)
    return 200, leaders


def api_leaders_create(q, body):
    require(body, "name")
    ts = iso(now_utc())
    with db() as conn:
        cur = conn.execute("INSERT INTO leaders (name, name_variants, organization, alert_contact, created_at)"
                           " VALUES (?,?,?,?,?)",
                           (body["name"].strip(), json.dumps(as_list(body.get("name_variants"))),
                            body.get("organization"), body.get("alert_contact"), ts))
        if str(body.get("event_name", "")).strip():
            conn.execute("INSERT INTO events (leader_id, name, event_date, location, created_at) VALUES (?,?,?,?,?)",
                         (cur.lastrowid, body["event_name"].strip(), body.get("event_date"),
                          body.get("event_location"), ts))
    return 201, {"id": cur.lastrowid}


def api_alerts_list(q, body):
    with db() as conn:
        rows = conn.execute("SELECT a.*, l.name AS leader_name FROM alerts a JOIN leaders l ON l.id=a.leader_id"
                            " ORDER BY a.created_at DESC LIMIT 50").fetchall()
    return 200, [dict(r) for r in rows]


def api_alert_seen(q, body, alert_id):
    with db() as conn:
        conn.execute("UPDATE alerts SET seen=1 WHERE id=?", (int(alert_id),))
    return 200, {"ok": True}


DEMO_POSTS = [
    ("facebook", "{name} umiyak na naman sa session. iyakin talaga, paano ka mamumuno?", 1),
    ("facebook", "Bumalik ka na sa kusina, {name}. Hindi ka para sa politika.", 4),
    ("x", "{name} is too emotional to lead, everyone saw it at the hearing.", 2),
    ("facebook", "LEAKED VIDEO ni {name}, panoorin bago ma-delete!!", 3),
    ("tiktok", "Puppet lang ng asawa si {name}, siya talaga nagdedesisyon.", 6),
    ("x", "{name} should be home with her kids, not in office.", 5),
]


def api_demo_inject(q, body):
    """Adds a burst of fake reports about one leader so you can show the alert firing."""
    require(body, "leader_id")
    leader_id, count = int(body["leader_id"]), max(1, min(int(body.get("count", 12)), 60))
    with db() as conn:
        leader = conn.execute("SELECT name FROM leaders WHERE id=?", (leader_id,)).fetchone()
        if not leader:
            return 404, {"error": "No leader with that id."}
        terms = {r["id"]: r for r in conn.execute("SELECT id, category FROM lexicon")}
        for i in range(count):
            platform, text, lex_id = DEMO_POSTS[i % len(DEMO_POSTS)]
            when = iso(now_utc() - timedelta(minutes=7 * i))
            conn.execute(
                "INSERT INTO reports (created_at, url, platform, lexicon_id, matched_text, context_text, category,"
                " reporter_role, country, leader_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (when, f"https://example.com/post/demo-{i}", platform, lex_id if lex_id in terms else None,
                 text.format(name=leader["name"]), text.format(name=leader["name"]),
                 terms[lex_id]["category"] if lex_id in terms else "unclassified", "ally", "PH", leader_id))
        alert = check_spike(conn, leader_id)
    return 201, {"inserted": count, "alert_triggered": alert}


def api_demo_reset_alerts(q, body):
    with db() as conn:
        conn.execute("DELETE FROM alerts")
        conn.execute("DELETE FROM reports WHERE url LIKE 'https://example.com/post/demo-%'")
    return 200, {"ok": True}


def api_incidents_list(q, body):
    sql, args = ("SELECT i.*, l.name AS leader_name FROM incidents i LEFT JOIN leaders l ON l.id=i.leader_id", [])
    if q.get("leader_id"):
        sql += " WHERE i.leader_id=?"
        args.append(int(q["leader_id"]))
    with db() as conn:
        rows = conn.execute(sql + " ORDER BY i.created_at DESC", args).fetchall()
    return 200, [row_to_dict(r, ["files"]) for r in rows]


def api_incidents_create(q, body):
    require(body, "description")
    stored = []
    for f in body.get("files", [])[:10]:
        if f.get("data_b64"):
            fname, digest = save_b64_file(f["data_b64"], "incident", f.get("name", "file.bin"))
            stored.append({"name": f.get("name", fname), "file": fname, "sha256": digest})
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO incidents (leader_id, created_at, occurred_at, description, witnesses, files)"
            " VALUES (?,?,?,?,?,?)",
            (body.get("leader_id") or None, iso(now_utc()), body.get("occurred_at"),
             body["description"].strip(), body.get("witnesses", ""), json.dumps(stored)))
    return 201, {"id": cur.lastrowid, "files": stored}


def api_legal_info(q, body):
    country = (q.get("country") or "PH").upper()
    info = LEGAL_INFO.get(country)
    if not info:
        return 404, {"error": f"No legal info for {country} yet."}
    platform = (q.get("platform") or "other").lower()
    return 200, info | {"report_steps": PLATFORM_STEPS.get(platform, PLATFORM_STEPS["other"]),
                        "platform": platform}


ROUTES = [
    ("GET", r"/api/status", api_status),
    ("GET", r"/api/lexicon", api_lexicon),
    ("GET", r"/api/submissions", api_submissions_list),
    ("POST", r"/api/submissions", api_submissions_create),
    ("POST", r"/api/submissions/(\d+)/(approve|reject)", api_submission_review),
    ("GET", r"/api/reports", api_reports_list),
    ("POST", r"/api/reports", api_reports_create),
    ("GET", r"/api/leaders", api_leaders_list),
    ("POST", r"/api/leaders", api_leaders_create),
    ("GET", r"/api/alerts", api_alerts_list),
    ("POST", r"/api/alerts/(\d+)/seen", api_alert_seen),
    ("GET", r"/api/incidents", api_incidents_list),
    ("POST", r"/api/incidents", api_incidents_create),
    ("GET", r"/api/legal-info", api_legal_info),
    ("POST", r"/api/demo/inject", api_demo_inject),
    ("POST", r"/api/demo/reset", api_demo_reset_alerts),
]

PAGES = {"/": "index.html", "/test-feed": "test-feed.html", "/test-article": "test-article.html"}
MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
        ".gif": "image/gif", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav",
        ".webm": "audio/webm", ".ogg": "audio/ogg", ".pdf": "application/pdf"}


class Handler(BaseHTTPRequestHandler):
    server_version = "Kalasag/0.1"

    def log_message(self, fmt, *args):
        print(f"{self.command} {self.path.split('?')[0]} -> {args[1] if len(args) > 1 else ''}")

    def _cors(self):
        # The extension can also reach us via host_permissions; this just makes testing easier.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, payload):
        self._send(code, json.dumps(payload, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def _dispatch(self, method):
        url = urlparse(self.path)
        path = url.path.rstrip("/") or "/"
        q = {k: v[0] for k, v in parse_qs(url.query).items()}

        if method == "GET" and path in PAGES:
            with open(os.path.join(STATIC_DIR, PAGES[path]), "rb") as fh:
                return self._send(200, fh.read(), "text/html; charset=utf-8")
        if method == "GET" and path.startswith("/evidence/"):
            name = os.path.basename(path)          # blocks ../ tricks
            full = os.path.join(EVIDENCE_DIR, name)
            if not os.path.isfile(full):
                return self._json(404, {"error": "File not found."})
            with open(full, "rb") as fh:
                ext = os.path.splitext(name)[1].lower()
                return self._send(200, fh.read(), MIME.get(ext, "application/octet-stream"))

        for m, pattern, fn in ROUTES:
            match = re.fullmatch(pattern, path)
            if m != method or not match:
                continue
            try:
                body = {}
                if method == "POST":
                    length = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(length) or b"{}") if length else {}
                code, payload = fn(q, body, *match.groups())
                return self._json(code, payload)
            except (ValueError, KeyError, json.JSONDecodeError) as e:
                return self._json(400, {"error": str(e)})
            except Exception as e:
                print("Server error:", repr(e))
                return self._json(500, {"error": "Something went wrong on the server. See the terminal."})
        self._json(404, {"error": f"No route for {method} {path}"})


if __name__ == "__main__":
    init_db()
    print(f"\nKalasag demo running at http://localhost:{PORT}")
    print(f"Test pages for the extension: http://localhost:{PORT}/test-feed  and  /test-article")
    print("AI drafting and summaries:", "ON" if API_KEY else "OFF (set ANTHROPIC_API_KEY to turn on)")
    print("Press Ctrl+C to stop.\n")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
