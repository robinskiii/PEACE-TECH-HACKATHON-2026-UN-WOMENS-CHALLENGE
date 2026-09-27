#!/usr/bin/env python3
"""
Kalasag demo backend: word database, reports, early-warning alerts, incident evidence.

Uses only the Python standard library, so there is nothing to install.
Run:   python app.py
Open:  http://localhost:8000          (dashboard)
       http://localhost:8000/test-feed (fake social feed to test the extension on)

Shared online database: put SUPABASE_URL and SUPABASE_SECRET_KEY in website/.env
       (without them, data is kept in a local file, kalasag.db).
Optional AI features (drafting word entries, alert summaries):
       set ANTHROPIC_API_KEY in website/.env or in your terminal.
"""
import base64
import hashlib
import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from store import SupabaseError, load_env_file, open_store

HOST, PORT = "127.0.0.1", 8000
BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE, "kalasag.db")
EVIDENCE_DIR = os.path.join(BASE, "evidence")
STATIC_DIR = os.path.join(BASE, "static")

load_env_file(os.path.join(BASE, ".env"))   # optional, git-ignored: keys for Supabase and the AI
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
# Two levels: every detailed category above belongs to one of the guide's broad categories.
BROAD_LABELS = {
    "gender_hate_speech": "Gender hate speech",
    "gendered_disinformation": "Gendered disinformation",
    "manipulated_text": "Manipulated text or context",
    "unclassified": "Not yet classified",
}
BROAD_OF = {
    "sexualized_slur": "gender_hate_speech", "emotional_unfitness": "gender_hate_speech",
    "family_role": "gender_hate_speech", "appearance": "gender_hate_speech",
    "misogynistic_generalization": "gender_hate_speech", "threat": "gender_hate_speech",
    "competence_undermining": "gendered_disinformation", "fabricated_scandal": "gendered_disinformation",
    "unclassified": "unclassified",
}
SEVERITIES = ["low", "medium", "high"]
REPORT_SOURCES = ("word_list", "ai", "highlight")
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


def parse_ts(value):
    """Read a timestamp from either database (works on Python 3.9 too)."""
    text = str(value).replace("Z", "+00:00").replace(" ", "T")
    if "." in text[19:]:                       # drop fractions of a second
        head, tail = text[:19], text[19:]
        tail = tail[tail.index("+"):] if "+" in tail else ""
        text = head + tail
    dt = datetime.fromisoformat(text)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


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
    STORE.save_file(name, raw, MIME.get(ext, "application/octet-stream"))
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


STORE = None   # set in main(): Supabase if configured, otherwise the local SQLite file


def seed_demo_data():
    """First run only: fictional leaders, Tagalog/English terms and a quiet week of reports."""
    if not STORE.is_empty():
        return
    print("Seeding demo data (fictional leaders and placeholder terms)...")
    ts = iso(now_utc())
    term_ids = []
    for term, variants, lang, meaning, cat, sev, note in SEED_TERMS:
        row = STORE.lexicon_insert({
            "term": term, "variants": variants, "language": lang, "country": "PH", "meaning": meaning,
            "category": cat, "severity": sev, "context_note": note, "status": "approved",
            "submitted_by": "seed", "approved_by": "Demo partner org", "created_at": ts, "updated_at": ts})
        term_ids.append(row["id"])
    for term, lang, country, raw, who, draft in SEED_PENDING:
        draft = draft or {"meaning": raw, "category": "unclassified", "severity": "medium",
                          "variants": leet_variants(term), "context_note": "", "ai_drafted": 0}
        STORE.lexicon_insert({
            "term": term, "variants": draft["variants"], "language": lang, "country": country,
            "meaning": draft["meaning"], "category": draft["category"], "severity": draft["severity"],
            "context_note": draft["context_note"], "status": "pending", "raw_submission": raw,
            "submitted_by": who, "ai_drafted": draft["ai_drafted"], "created_at": ts, "updated_at": ts})

    leaders = [
        ("Mayor Liza Reyes", ["Liza Reyes", "Mayor Reyes", "Mayora Liza", "Liza"],
         "UN Women Philippines (demo)", "alerts@example.org",
         ("Town hall on the port project", 5, "City hall")),
        ("Sen. Carmen Dela Cruz", ["Carmen Dela Cruz", "Dela Cruz", "Sen. Dela Cruz", "Senadora Carmen"],
         "Women in Governance Network (demo)", "team@example.org",
         ("Maternal health bill hearing", 12, "Senate, Pasay")),
    ]
    leader_ids = []
    for name, variants, org, contact, (ev_name, in_days, loc) in leaders:
        leader_id = STORE.leader_insert({"name": name, "name_variants": variants, "organization": org,
                                         "alert_contact": contact, "created_at": ts})
        leader_ids.append(leader_id)
        STORE.event_insert({"leader_id": leader_id, "name": ev_name, "location": loc, "created_at": ts,
                            "event_date": (now_utc() + timedelta(days=in_days)).strftime("%Y-%m-%d")})

    # Two quiet weeks of background reports (about 1 a day each, mixed narratives),
    # so the trends dashboard has a history and a spike stands out.
    background = [(0, "facebook"), (5, "facebook"), (3, "x"), (2, "tiktok"), (0, "x"), (4, "facebook"), (5, "tiktok")]
    for n, leader_id in enumerate(leader_ids):
        for day in range(1, 15):
            idx, platform = background[(day + n) % len(background)]
            idx = idx % len(term_ids)
            STORE.report_insert({
                "created_at": iso(now_utc() - timedelta(days=day, hours=3 + 5 * n)),
                "url": f"https://example.com/post/baseline-{leader_id}-{day}", "platform": platform,
                "lexicon_id": term_ids[idx], "matched_text": SEED_TERMS[idx][0],
                "category": SEED_TERMS[idx][4], "reporter_role": "ally", "country": "PH",
                "leader_id": leader_id})


def with_broad(row, field="category"):
    """Add the guide's broad category next to the detailed one."""
    cat = row.get(field) or "unclassified"
    broad = BROAD_OF.get(cat, "unclassified")
    return {**row, "category_label": CATEGORIES.get(cat, cat), "broad_category": broad,
            "broad_label": BROAD_LABELS[broad]}


# ---------------------------------------------------------------- core logic

def find_leader(*texts):
    blob = " ".join(t for t in texts if t).lower()
    if not blob:
        return None
    for leader in STORE.leaders_list():
        names = [leader["name"]] + list(leader.get("name_variants") or [])
        # Longest names first so "Mayor Reyes" wins over a short nickname.
        for n in sorted(names, key=len, reverse=True):
            if len(n) >= 4 and n.lower() in blob:
                return leader["id"]
    return None


def check_spike(leader_id):
    """Create an alert if reports about this leader have spiked. Returns the alert or None."""
    now = now_utc()
    since_24h, since_8d = iso(now - timedelta(hours=24)), iso(now - timedelta(days=8))
    count = STORE.reports_count(leader_id, since_24h)
    baseline = STORE.reports_count(leader_id, since_8d, until=since_24h) / 7.0
    if count < SPIKE_MIN or count < SPIKE_MULTIPLIER * max(baseline, 1.0):
        return None
    if STORE.alert_exists_since(leader_id, iso(now - timedelta(hours=ALERT_COOLDOWN_HOURS))):
        return None

    rows = STORE.reports_for_leader(leader_id, since_24h, limit=40)
    leader = STORE.leader_get(leader_id)
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
    alert_id = STORE.alert_insert({"leader_id": leader_id, "created_at": iso(now), "count_24h": count,
                                   "baseline_per_day": round(baseline, 2), "summary": summary.strip()})
    print(f"ALERT for leader {leader_id}: {count} reports in 24h")
    return {"id": alert_id, "leader_id": leader_id, "count_24h": count, "summary": summary.strip()}


# ---------------------------------------------------------------- route handlers
# Each returns (status_code, json_payload).

def api_status(q, body):
    return 200, {"ai_enabled": bool(API_KEY), "model": MODEL if API_KEY else None,
                 "database": STORE.kind, "reports_pending": STORE.reports_pending_count(),
                 "categories": CATEGORIES, "broad_categories": BROAD_LABELS, "broad_of": BROAD_OF,
                 "languages": LANGUAGES, "severities": SEVERITIES}


def api_lexicon(q, body):
    """What the extension downloads. Only approved entries."""
    country = (q.get("country") or "").upper() or None
    rows = STORE.lexicon_list("approved", country=country, languages=as_list(q.get("languages")))
    entries = [with_broad({k: e[k] for k in ("id", "term", "variants", "language", "country", "meaning",
                                             "category", "severity", "context_note")})
               for e in rows]
    return 200, {"version": STORE.lexicon_version(), "count": len(entries), "entries": entries}


def api_submissions_list(q, body):
    return 200, STORE.lexicon_list(q.get("status", "pending"))


def api_submissions_create(q, body):
    require(body, "term", "language", "country", "explanation")
    term = body["term"].strip()
    lang, country = body["language"].strip(), body["country"].strip().upper()
    raw = body["explanation"].strip()
    draft = ai_draft_entry(term, lang, country, raw)
    ts = iso(now_utc())
    row = STORE.lexicon_insert({
        "term": term, "variants": draft["variants"], "language": lang, "country": country,
        "meaning": draft["meaning"], "category": draft["category"], "severity": draft["severity"],
        "context_note": draft["context_note"], "status": "pending", "raw_submission": raw,
        "submitted_by": body.get("submitted_by", "anonymous"), "ai_drafted": draft["ai_drafted"],
        "created_at": ts, "updated_at": ts})
    return 201, row


def api_submission_review(q, body, entry_id, decision):
    row = STORE.lexicon_get(entry_id)
    if not row:
        return 404, {"error": "No entry with that id."}
    if decision == "reject":
        row = STORE.lexicon_update(entry_id, {"status": "rejected", "approved_by": body.get("reviewer", ""),
                                              "updated_at": iso(now_utc())})
    else:
        require(body, "reviewer")
        category = body.get("category", row["category"])
        if category not in CATEGORIES or category == "unclassified":
            raise ValueError("Choose a category before approving.")
        severity = body.get("severity", row["severity"])
        if severity not in SEVERITIES:
            raise ValueError("Severity must be low, medium or high.")
        row = STORE.lexicon_update(entry_id, {
            "term": body.get("term", row["term"]).strip(), "meaning": body.get("meaning", row["meaning"]),
            "category": category, "severity": severity,
            "variants": as_list(body["variants"]) if "variants" in body else row["variants"],
            "context_note": body.get("context_note", row["context_note"]),
            "status": "approved", "approved_by": body["reviewer"], "updated_at": iso(now_utc())})
    return 200, row


def api_reports_create(q, body):
    """What the extension sends when the user clicks 'Save as evidence'."""
    if not (body.get("matched_text") or body.get("lexicon_id")):
        raise ValueError("Send matched_text or lexicon_id.")
    category = body.get("category")
    if body.get("lexicon_id") and not category:
        entry = STORE.lexicon_get(body["lexicon_id"])
        category = entry["category"] if entry else None
    if category not in CATEGORIES:
        category = "unclassified"
    leader_id = body.get("leader_id") or find_leader(body.get("context_text"), body.get("matched_text"))
    # Word-list matches were already checked by experts when the word was approved, so they count at once.
    # Text a person highlighted, and AI-only finds, wait for an expert.
    source = body.get("source") if body.get("source") in REPORT_SOURCES else ("word_list" if body.get("lexicon_id") else "highlight")
    status = "approved" if source == "word_list" else "pending"
    shot_file = shot_hash = None
    if body.get("screenshot_b64"):
        shot_file, shot_hash = save_b64_file(body["screenshot_b64"], "report", "screenshot.png")
    saved = STORE.report_insert({
        "created_at": iso(now_utc()), "url": body.get("url"), "platform": (body.get("platform") or "other").lower(),
        "lexicon_id": body.get("lexicon_id"), "matched_text": body.get("matched_text"),
        "context_text": (body.get("context_text") or "")[:2000], "category": category,
        "reporter_role": body.get("reporter_role"), "country": (body.get("country") or "PH").upper(),
        "leader_id": leader_id, "screenshot_file": shot_file, "screenshot_sha256": shot_hash,
        "source": source, "status": status, "reporter_note": (body.get("reporter_note") or "")[:1000] or None})
    alert = check_spike(leader_id) if leader_id and status == "approved" else None
    return 201, {"id": saved["id"], "created_at": saved["created_at"], "leader_id": leader_id, "status": status,
                 "screenshot_sha256": shot_hash, "alert_triggered": alert}


def api_reports_list(q, body):
    limit = min(int(q.get("limit", 100)), 500)
    status = q.get("status", "approved")
    if status not in ("pending", "approved", "rejected"):
        raise ValueError("status must be pending, approved or rejected.")
    return 200, [with_broad(r) for r in STORE.reports_list(limit, status=status)]


def api_report_review(q, body, report_id, decision):
    """An expert approves a waiting report (it then counts everywhere) or rejects it."""
    require(body, "reviewer")
    report = STORE.report_get(report_id)
    if not report:
        return 404, {"error": "Report not found."}
    if report["status"] != "pending":
        raise ValueError(f"This report was already {report['status']}.")
    fields = {"status": "approved" if decision == "approve" else "rejected",
              "reviewed_by": body["reviewer"].strip()[:200], "reviewed_at": iso(now_utc())}
    if decision == "approve":
        if body.get("category") in CATEGORIES:
            fields["category"] = body["category"]
        if "leader_id" in body:
            fields["leader_id"] = int(body["leader_id"]) if body.get("leader_id") else None
    STORE.report_update(report_id, fields)
    leader_id = fields.get("leader_id", report.get("leader_id"))
    alert = check_spike(leader_id) if decision == "approve" and leader_id else None
    return 200, {"id": int(report_id), "status": fields["status"], "alert_triggered": alert}


def api_leaders_list(q, body):
    since = iso(now_utc() - timedelta(hours=24))
    leaders = []
    for leader in STORE.leaders_list():
        leaders.append({**leader, "events": STORE.events_for(leader["id"]),
                        "reports_24h": STORE.reports_count(leader["id"], since)})
    return 200, leaders


def api_leaders_create(q, body):
    require(body, "name")
    ts = iso(now_utc())
    leader_id = STORE.leader_insert({"name": body["name"].strip(), "name_variants": as_list(body.get("name_variants")),
                                     "organization": body.get("organization"),
                                     "alert_contact": body.get("alert_contact"), "created_at": ts})
    if str(body.get("event_name", "")).strip():
        STORE.event_insert({"leader_id": leader_id, "name": body["event_name"].strip(),
                            "event_date": body.get("event_date"), "location": body.get("event_location"),
                            "created_at": ts})
    return 201, {"id": leader_id}


def api_alerts_list(q, body):
    return 200, STORE.alerts_list()


def api_alert_seen(q, body, alert_id):
    STORE.alert_mark_seen(alert_id)
    return 200, {"ok": True}


DEMO_POSTS = [
    ("facebook", "{name} umiyak na naman sa session. iyakin talaga, paano ka mamumuno?", 0),
    ("facebook", "Bumalik ka na sa kusina, {name}. Hindi ka para sa politika.", 3),
    ("x", "{name} is too emotional to lead, everyone saw it at the hearing.", 1),
    ("facebook", "LEAKED VIDEO ni {name}, panoorin bago ma-delete!!", 2),
    ("tiktok", "Puppet lang ng asawa si {name}, siya talaga nagdedesisyon.", 5),
    ("x", "{name} should be home with her kids, not in office.", 4),
]


def api_demo_inject(q, body):
    """Adds a burst of fake reports about one leader so you can show the alert firing."""
    require(body, "leader_id")
    leader_id, count = int(body["leader_id"]), max(1, min(int(body.get("count", 12)), 60))
    leader = STORE.leader_get(leader_id)
    if not leader:
        return 404, {"error": "No leader with that id."}
    approved = {e["term"]: e for e in STORE.lexicon_list("approved")}
    for i in range(count):
        platform, text, seed_idx = DEMO_POSTS[i % len(DEMO_POSTS)]
        entry = approved.get(SEED_TERMS[seed_idx][0])
        post = text.format(name=leader["name"])
        STORE.report_insert({
            "created_at": iso(now_utc() - timedelta(minutes=7 * i)), "url": f"https://example.com/post/demo-{i}",
            "platform": platform, "lexicon_id": entry["id"] if entry else None, "matched_text": post,
            "context_text": post, "category": entry["category"] if entry else "unclassified",
            "reporter_role": "ally", "country": "PH", "leader_id": leader_id})
    return 201, {"inserted": count, "alert_triggered": check_spike(leader_id)}


def api_demo_reset_alerts(q, body):
    STORE.demo_reset()
    return 200, {"ok": True}


def api_incidents_list(q, body):
    return 200, STORE.incidents_list(q.get("leader_id"))


def api_incidents_create(q, body):
    require(body, "description")
    stored = []
    for f in body.get("files", [])[:10]:
        if f.get("data_b64"):
            fname, digest = save_b64_file(f["data_b64"], "incident", f.get("name", "file.bin"))
            stored.append({"name": f.get("name", fname), "file": fname, "sha256": digest})
    incident_id = STORE.incident_insert({
        "leader_id": body.get("leader_id") or None, "created_at": iso(now_utc()),
        "occurred_at": body.get("occurred_at") or None, "description": body["description"].strip(),
        "witnesses": body.get("witnesses", ""), "files": stored})
    return 201, {"id": incident_id, "files": stored}


def api_stats(q, body):
    """Numbers for the trends dashboard: what is being said, about whom, where, and is it rising."""
    days = max(7, min(int(q.get("days", 14)), 90))
    now = now_utc()
    start_day = (now - timedelta(days=days - 1)).date()
    rows = STORE.reports_since(iso(datetime.combine(start_day - timedelta(days=days), datetime.min.time(),
                                                    tzinfo=timezone.utc)))

    def day_of(r):
        return str(r["created_at"])[:10]

    def at(r):
        return parse_ts(r["created_at"])

    window = [r for r in rows if day_of(r) >= start_day.isoformat()]
    earlier = [r for r in rows if day_of(r) < start_day.isoformat()]
    dates = [(start_day + timedelta(days=i)).isoformat() for i in range(days)]

    leaders = {l["id"]: l for l in STORE.leaders_list()}
    per_leader_day = {lid: {d: 0 for d in dates} for lid in leaders}
    unmatched = {d: 0 for d in dates}
    for r in window:
        target = per_leader_day.get(r["leader_id"], unmatched) if r["leader_id"] else unmatched
        target[day_of(r)] = target.get(day_of(r), 0) + 1

    def tally(items, key):
        out = {}
        for r in items:
            k = key(r) or "unknown"
            out[k] = out.get(k, 0) + 1
        return out

    week_ago, two_weeks_ago = now - timedelta(days=7), now - timedelta(days=14)
    this_week = [r for r in rows if at(r) >= week_ago]
    last_week = [r for r in rows if two_weeks_ago <= at(r) < week_ago]
    cat_now, cat_before = tally(this_week, lambda r: r["category"]), tally(last_week, lambda r: r["category"])
    narratives = sorted(
        ({"category": c, "label": CATEGORIES.get(c, c), "broad_category": BROAD_OF.get(c, "unclassified"),
          "this_week": cat_now.get(c, 0), "last_week": cat_before.get(c, 0),
          "change": cat_now.get(c, 0) - cat_before.get(c, 0)}
         for c in set(cat_now) | set(cat_before)),
        key=lambda n: (-n["this_week"], -n["change"]))

    since_24h = now - timedelta(hours=24)
    leader_rows = []
    for lid, leader in leaders.items():
        mine = [r for r in rows if r["leader_id"] == lid]
        last_24h = sum(1 for r in mine if at(r) >= since_24h)
        prev_7d = sum(1 for r in mine if now - timedelta(days=8) <= at(r) < since_24h)
        top = sorted(tally([r for r in mine if at(r) >= week_ago], lambda r: r["category"]).items(),
                     key=lambda kv: -kv[1])
        events = [e for e in STORE.events_for(lid) if (e.get("event_date") or "") >= now.date().isoformat()]
        leader_rows.append({
            "id": lid, "name": leader["name"], "last_24h": last_24h,
            "usual_per_day": round(prev_7d / 7.0, 1), "this_week": sum(1 for r in mine if at(r) >= week_ago),
            "top_narrative": CATEGORIES.get(top[0][0], top[0][0]) if top else None,
            "next_event": events[0] if events else None})
    leader_rows.sort(key=lambda l: -l["last_24h"])

    alerts = STORE.alerts_list()
    return 200, {
        "days": dates,
        "totals": {"reports": len(window), "last_24h": sum(1 for r in rows if at(r) >= since_24h),
                   "this_week": len(this_week), "last_week": len(last_week),
                   "leaders_targeted": len({r["leader_id"] for r in window if r["leader_id"]}),
                   "open_alerts": sum(1 for a in alerts if not a["seen"])},
        "series": [{"leader_id": lid, "name": leaders[lid]["name"], "counts": [per_leader_day[lid][d] for d in dates]}
                   for lid in leaders]
                  + ([{"leader_id": None, "name": "Not matched to a leader", "counts": [unmatched[d] for d in dates]}]
                     if any(unmatched.values()) else []),
        "narratives": narratives,
        "broad": [{"broad_category": b, "label": BROAD_LABELS[b],
                   "count": sum(1 for r in window if BROAD_OF.get(r["category"], "unclassified") == b)}
                  for b in BROAD_LABELS],
        "platforms": sorted(({"platform": p, "count": n} for p, n in tally(window, lambda r: r["platform"]).items()),
                            key=lambda p: -p["count"]),
        "leaders": leader_rows,
        "database": STORE.kind,
    }


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
    ("GET", r"/api/stats", api_stats),
    ("GET", r"/api/submissions", api_submissions_list),
    ("POST", r"/api/submissions", api_submissions_create),
    ("POST", r"/api/submissions/(\d+)/(approve|reject)", api_submission_review),
    ("GET", r"/api/reports", api_reports_list),
    ("POST", r"/api/reports", api_reports_create),
    ("POST", r"/api/reports/(\d+)/(approve|reject)", api_report_review),
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
            content = STORE.read_file(name)
            if content is None:
                return self._json(404, {"error": "File not found."})
            ext = os.path.splitext(name)[1].lower()
            return self._send(200, content, MIME.get(ext, "application/octet-stream"))

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
            except SupabaseError as e:
                print("Database error:", e)
                return self._json(502, {"error": "The online database didn't respond as expected. See the terminal."})
            except Exception as e:
                print("Server error:", repr(e))
                return self._json(500, {"error": "Something went wrong on the server. See the terminal."})
        self._json(404, {"error": f"No route for {method} {path}"})


if __name__ == "__main__":
    STORE = open_store(DB_PATH, EVIDENCE_DIR)
    seed_demo_data()
    print(f"\nKalasag demo running at http://localhost:{PORT}")
    print("Database:", "Supabase (shared, online)" if STORE.kind == "supabase"
          else "local file kalasag.db (set SUPABASE_URL and SUPABASE_SECRET_KEY in website/.env to share data)")
    print(f"Test pages for the extension: http://localhost:{PORT}/test-feed  and  /test-article")
    print("AI drafting and summaries:", "ON" if API_KEY else "OFF (set ANTHROPIC_API_KEY to turn on)")
    print("Press Ctrl+C to stop.\n")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
