"""
Where Kalasag keeps its data.

Two interchangeable backends with the same methods:
  * SupabaseStore: the shared online database (used when SUPABASE_URL and
    SUPABASE_SECRET_KEY are set). Everyone on the team sees the same data.
  * SQLiteStore:   a local file, kalasag.db. Used when Supabase isn't set up,
    e.g. offline. Only the computer running app.py sees this data.

Only the Python standard library is used, so there is still nothing to install.
"""
import json
import os
import sqlite3
import urllib.error
import urllib.parse
import urllib.request


# =====================================================================
# Supabase (online, shared)
# =====================================================================

class SupabaseError(Exception):
    pass


class SupabaseStore:
    kind = "supabase"
    BUCKET = "evidence"

    def __init__(self, url, secret_key):
        self.url = url.rstrip("/")
        self.key = secret_key

    # ---------- low-level HTTP
    def _request(self, method, path, params=None, body=None, headers=None, raw_body=None, want_raw=False):
        query = ""
        if params:
            query = "?" + urllib.parse.urlencode(params, safe=",.*():")
        h = {"apikey": self.key}
        if not self.key.startswith("sb_"):
            # Older JWT-style keys (service_role) also go in the Authorization header.
            # New sb_secret_ keys go in the apikey header only.
            h["Authorization"] = f"Bearer {self.key}"
        data = None
        if raw_body is not None:
            data = raw_body
        elif body is not None:
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        req = urllib.request.Request(self.url + path + query, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                content = resp.read()
                if want_raw:
                    return content, resp.headers
                return json.loads(content) if content else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:400]
            raise SupabaseError(f"Supabase {method} {path} failed ({e.code}): {detail}") from None

    def _select(self, table, **params):
        return self._request("GET", f"/rest/v1/{table}", params) or []

    def _insert(self, table, row):
        rows = self._request("POST", f"/rest/v1/{table}", body=row,
                             headers={"Prefer": "return=representation"})
        return rows[0]

    def _update(self, table, filters, fields):
        return self._request("PATCH", f"/rest/v1/{table}", params=filters, body=fields,
                             headers={"Prefer": "return=representation"}) or []

    def _delete(self, table, filters):
        self._request("DELETE", f"/rest/v1/{table}", params=filters)

    def _count(self, table, **filters):
        _, headers = self._request("HEAD", f"/rest/v1/{table}", params={"select": "id", **filters},
                                   headers={"Prefer": "count=exact"}, want_raw=True)
        return int((headers.get("Content-Range") or "*/0").split("/")[-1])

    # ---------- setup
    def check(self):
        """Fails with a clear message if the tables haven't been created yet."""
        try:
            self._select("categories", select="code", limit="1")
        except SupabaseError as e:
            raise SupabaseError("Can't read the Supabase tables. Run database/schema.sql in the "
                                f"Supabase SQL Editor first. Details: {e}") from None

    def is_empty(self):
        return self._count("lexicon") == 0

    # ---------- lexicon
    def lexicon_insert(self, row):
        return self._insert("lexicon", _pg_row(row))

    def lexicon_list(self, status, country=None, languages=None):
        params = {"select": "*", "status": f"eq.{status}",
                  "order": "term.asc" if status == "approved" else "created_at.desc"}
        if country:
            params["country"] = f"eq.{country}"
        if languages:
            params["language"] = f"in.({','.join(languages)})"
        return self._select("lexicon", **params)

    def lexicon_version(self):
        rows = self._select("lexicon", select="updated_at", status="eq.approved",
                            order="updated_at.desc", limit="1")
        return rows[0]["updated_at"] if rows else None

    def lexicon_get(self, entry_id):
        rows = self._select("lexicon", select="*", id=f"eq.{int(entry_id)}")
        return rows[0] if rows else None

    def lexicon_update(self, entry_id, fields):
        rows = self._update("lexicon", {"id": f"eq.{int(entry_id)}"}, _pg_row(fields))
        return rows[0] if rows else None

    # ---------- leaders and events
    def leaders_list(self):
        return self._select("leaders", select="*", order="name.asc")

    def leader_get(self, leader_id):
        rows = self._select("leaders", select="*", id=f"eq.{int(leader_id)}")
        return rows[0] if rows else None

    def leader_insert(self, row):
        return self._insert("leaders", row)["id"]

    def events_for(self, leader_id):
        return self._select("events", select="*", leader_id=f"eq.{int(leader_id)}", order="event_date.asc")

    def event_insert(self, row):
        self._insert("events", {**row, "event_date": row.get("event_date") or None})

    # ---------- reports
    def report_insert(self, row):
        return self._insert("reports", row)

    def reports_count(self, leader_id, since, until=None):
        filters = {"leader_id": f"eq.{int(leader_id)}", "created_at": f"gte.{since}"}
        if until:
            filters["and"] = f"(created_at.lt.{until})"
        return self._count("reports", **filters)

    def reports_for_leader(self, leader_id, since, limit=40):
        return self._select("reports", select="platform,category,context_text,matched_text",
                            leader_id=f"eq.{int(leader_id)}", created_at=f"gte.{since}",
                            order="created_at.desc", limit=str(limit))

    def reports_list(self, limit=100):
        rows = self._select("reports", select="*,leaders(name),lexicon(term)",
                            order="created_at.desc", limit=str(limit))
        return [_flatten(r) for r in rows]

    def reports_since(self, since):
        rows = self._select("reports", select="id,created_at,platform,category,leader_id,leaders(name)",
                            created_at=f"gte.{since}", order="created_at.asc", limit="10000")
        return [_flatten(r) for r in rows]

    # ---------- alerts
    def alert_exists_since(self, leader_id, since):
        return self._count("alerts", leader_id=f"eq.{int(leader_id)}", created_at=f"gte.{since}") > 0

    def alert_insert(self, row):
        return self._insert("alerts", row)["id"]

    def alerts_list(self, limit=50):
        rows = self._select("alerts", select="*,leaders(name)", order="created_at.desc", limit=str(limit))
        return [_flatten(r) for r in rows]

    def alert_mark_seen(self, alert_id):
        self._update("alerts", {"id": f"eq.{int(alert_id)}"}, {"seen": True})

    def demo_reset(self):
        self._delete("alerts", {"id": "gt.0"})
        self._delete("reports", {"url": "like.https://example.com/post/demo-*"})

    # ---------- incidents
    def incidents_list(self, leader_id=None):
        params = {"select": "*,leaders(name)", "order": "created_at.desc"}
        if leader_id:
            params["leader_id"] = f"eq.{int(leader_id)}"
        return [_flatten(r) for r in self._select("incidents", **params)]

    def incident_insert(self, row):
        return self._insert("incidents", row)["id"]

    # ---------- evidence files (private storage bucket)
    def save_file(self, name, raw, content_type="application/octet-stream"):
        self._request("POST", f"/storage/v1/object/{self.BUCKET}/{urllib.parse.quote(name)}",
                      raw_body=raw, headers={"Content-Type": content_type, "x-upsert": "false"})

    def read_file(self, name):
        try:
            content, _ = self._request("GET", f"/storage/v1/object/{self.BUCKET}/{urllib.parse.quote(name)}",
                                       want_raw=True)
            return content
        except SupabaseError:
            return None


def _flatten(row):
    """Turn Supabase's embedded {"leaders": {"name": ...}} into leader_name, and so on."""
    row = dict(row)
    leader = row.pop("leaders", None)
    lexicon = row.pop("lexicon", None)
    if "leader_id" in row or leader is not None:
        row["leader_name"] = leader["name"] if leader else None
    if lexicon is not None or "lexicon_id" in row:
        row["term"] = lexicon["term"] if lexicon else None
    return row


def _pg_row(row):
    """ai_drafted is a real boolean in Postgres."""
    row = dict(row)
    if "ai_drafted" in row:
        row["ai_drafted"] = bool(row["ai_drafted"])
    return row


# =====================================================================
# SQLite (local file, fallback)
# =====================================================================

SQLITE_SCHEMA = """
CREATE TABLE IF NOT EXISTS lexicon (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL, variants TEXT NOT NULL DEFAULT '[]',
    language TEXT NOT NULL, country TEXT NOT NULL,
    meaning TEXT, category TEXT NOT NULL DEFAULT 'unclassified',
    severity TEXT NOT NULL DEFAULT 'medium', context_note TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
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
    files TEXT NOT NULL DEFAULT '[]'
);
"""

JSON_FIELDS = ("variants", "name_variants", "files")


class SQLiteStore:
    kind = "sqlite"

    def __init__(self, db_path, evidence_dir):
        self.db_path = db_path
        self.evidence_dir = evidence_dir
        os.makedirs(evidence_dir, exist_ok=True)
        with self._conn() as conn:
            conn.executescript(SQLITE_SCHEMA)

    def _conn(self):
        conn = sqlite3.connect(self.db_path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    @staticmethod
    def _dict(row):
        if row is None:
            return None
        d = dict(row)
        for f in JSON_FIELDS:
            if f in d and isinstance(d[f], str):
                try:
                    d[f] = json.loads(d[f])
                except json.JSONDecodeError:
                    d[f] = []
        return d

    def _all(self, sql, args=()):
        with self._conn() as conn:
            return [self._dict(r) for r in conn.execute(sql, args).fetchall()]

    def _one(self, sql, args=()):
        with self._conn() as conn:
            return self._dict(conn.execute(sql, args).fetchone())

    def _insert(self, table, row):
        row = {k: (json.dumps(v) if k in JSON_FIELDS else v) for k, v in row.items()}
        cols = ", ".join(row)
        with self._conn() as conn:
            cur = conn.execute(f"INSERT INTO {table} ({cols}) VALUES ({', '.join('?' * len(row))})",
                               list(row.values()))
            return cur.lastrowid

    def check(self):
        pass

    def is_empty(self):
        return self._one("SELECT COUNT(*) AS n FROM lexicon")["n"] == 0

    # ---------- lexicon
    def lexicon_insert(self, row):
        return self.lexicon_get(self._insert("lexicon", row))

    def lexicon_list(self, status, country=None, languages=None):
        sql, args = "SELECT * FROM lexicon WHERE status=?", [status]
        if country:
            sql += " AND country=?"
            args.append(country)
        if languages:
            sql += f" AND language IN ({','.join('?' * len(languages))})"
            args += list(languages)
        sql += " ORDER BY term" if status == "approved" else " ORDER BY created_at DESC"
        return self._all(sql, args)

    def lexicon_version(self):
        return self._one("SELECT MAX(updated_at) AS v FROM lexicon WHERE status='approved'")["v"]

    def lexicon_get(self, entry_id):
        return self._one("SELECT * FROM lexicon WHERE id=?", (int(entry_id),))

    def lexicon_update(self, entry_id, fields):
        fields = {k: (json.dumps(v) if k in JSON_FIELDS else v) for k, v in fields.items()}
        with self._conn() as conn:
            conn.execute(f"UPDATE lexicon SET {', '.join(f'{k}=?' for k in fields)} WHERE id=?",
                         [*fields.values(), int(entry_id)])
        return self.lexicon_get(entry_id)

    # ---------- leaders and events
    def leaders_list(self):
        return self._all("SELECT * FROM leaders ORDER BY name")

    def leader_get(self, leader_id):
        return self._one("SELECT * FROM leaders WHERE id=?", (int(leader_id),))

    def leader_insert(self, row):
        return self._insert("leaders", row)

    def events_for(self, leader_id):
        return self._all("SELECT * FROM events WHERE leader_id=? ORDER BY event_date", (int(leader_id),))

    def event_insert(self, row):
        self._insert("events", row)

    # ---------- reports
    def report_insert(self, row):
        new_id = self._insert("reports", row)
        return {"id": new_id, "created_at": row["created_at"]}

    def reports_count(self, leader_id, since, until=None):
        sql, args = "SELECT COUNT(*) AS n FROM reports WHERE leader_id=? AND created_at>=?", [int(leader_id), since]
        if until:
            sql += " AND created_at<?"
            args.append(until)
        return self._one(sql, args)["n"]

    def reports_for_leader(self, leader_id, since, limit=40):
        return self._all("SELECT platform, category, context_text, matched_text FROM reports"
                         " WHERE leader_id=? AND created_at>=? ORDER BY created_at DESC LIMIT ?",
                         (int(leader_id), since, limit))

    def reports_list(self, limit=100):
        return self._all("SELECT r.*, l.name AS leader_name, x.term AS term FROM reports r"
                         " LEFT JOIN leaders l ON l.id=r.leader_id LEFT JOIN lexicon x ON x.id=r.lexicon_id"
                         " ORDER BY r.created_at DESC LIMIT ?", (limit,))

    def reports_since(self, since):
        return self._all("SELECT r.id, r.created_at, r.platform, r.category, r.leader_id, l.name AS leader_name"
                         " FROM reports r LEFT JOIN leaders l ON l.id=r.leader_id"
                         " WHERE r.created_at>=? ORDER BY r.created_at", (since,))

    # ---------- alerts
    def alert_exists_since(self, leader_id, since):
        return self._one("SELECT COUNT(*) AS n FROM alerts WHERE leader_id=? AND created_at>=?",
                         (int(leader_id), since))["n"] > 0

    def alert_insert(self, row):
        return self._insert("alerts", row)

    def alerts_list(self, limit=50):
        return self._all("SELECT a.*, l.name AS leader_name FROM alerts a JOIN leaders l ON l.id=a.leader_id"
                         " ORDER BY a.created_at DESC LIMIT ?", (limit,))

    def alert_mark_seen(self, alert_id):
        with self._conn() as conn:
            conn.execute("UPDATE alerts SET seen=1 WHERE id=?", (int(alert_id),))

    def demo_reset(self):
        with self._conn() as conn:
            conn.execute("DELETE FROM alerts")
            conn.execute("DELETE FROM reports WHERE url LIKE 'https://example.com/post/demo-%'")

    # ---------- incidents
    def incidents_list(self, leader_id=None):
        sql, args = "SELECT i.*, l.name AS leader_name FROM incidents i LEFT JOIN leaders l ON l.id=i.leader_id", []
        if leader_id:
            sql += " WHERE i.leader_id=?"
            args.append(int(leader_id))
        return self._all(sql + " ORDER BY i.created_at DESC", args)

    def incident_insert(self, row):
        return self._insert("incidents", row)

    # ---------- evidence files (local folder)
    def save_file(self, name, raw, content_type=None):
        with open(os.path.join(self.evidence_dir, name), "wb") as fh:
            fh.write(raw)

    def read_file(self, name):
        full = os.path.join(self.evidence_dir, os.path.basename(name))
        if not os.path.isfile(full):
            return None
        with open(full, "rb") as fh:
            return fh.read()


# =====================================================================
# Pick the backend
# =====================================================================

def load_env_file(path):
    """Read KEY=VALUE lines from website/.env (git-ignored) into the environment."""
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def open_store(db_path, evidence_dir):
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SECRET_KEY", "").strip()
    if url and key:
        store = SupabaseStore(url, key)
        store.check()
        return store
    return SQLiteStore(db_path, evidence_dir)
