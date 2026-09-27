#!/usr/bin/env python3
"""Kalasag validation dashboard. Run: python3 app.py, then open localhost:8000."""
import json, os, sqlite3
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "kalasag.db")
CATEGORIES = {"hate_speech": "Hate speech", "gendered_abuse": "Gendered abuse", "fabricated_claim": "Fabricated claim", "coordinated_harassment": "Coordinated harassment", "unclassified": "Needs classification"}
LANGUAGES = {"tl": "Tagalog", "en": "English", "ceb": "Cebuano", "ilo": "Ilocano"}

def now(): return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
def conn():
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row; return c
def init():
    with conn() as c:
        c.executescript("""CREATE TABLE IF NOT EXISTS submissions(
          id INTEGER PRIMARY KEY, term TEXT NOT NULL, language TEXT NOT NULL, country TEXT NOT NULL,
          explanation TEXT NOT NULL, selected_text TEXT, context_text TEXT, source_url TEXT, source_title TEXT,
          submitted_by TEXT, category TEXT DEFAULT 'unclassified', severity TEXT DEFAULT 'medium',
          status TEXT DEFAULT 'pending', reviewer TEXT, created_at TEXT NOT NULL, reviewed_at TEXT);
          CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, url TEXT, platform TEXT,
          matched_text TEXT, context_text TEXT, category TEXT DEFAULT 'unclassified', country TEXT);""")
        if not c.execute("SELECT COUNT(*) FROM reports").fetchone()[0]:
            cats = ["hate_speech", "fabricated_claim", "gendered_abuse", "fabricated_claim", "coordinated_harassment"]
            for d in range(13, -1, -1):
                for n in range((d * 3 + 1) % 5):
                    c.execute("INSERT INTO reports(created_at,platform,matched_text,category,country) VALUES(?,?,?,?,?)", ((datetime.now(timezone.utc)-timedelta(days=d, hours=n)).strftime("%Y-%m-%dT%H:%M:%SZ"), ["facebook","x","tiktok"][n%3], "Seeded demo activity", cats[(d+n)%len(cats)], "PH"))

def body(h):
    n = int(h.headers.get("Content-Length", "0")); return json.loads(h.rfile.read(n) or b"{}") if n else {}
def required(b, *keys):
    missing = [k for k in keys if not str(b.get(k, "")).strip()]
    if missing: raise ValueError("Missing: " + ", ".join(missing))
def trends(days):
    days = max(7, min(int(days), 90)); start = datetime.now(timezone.utc).date() - timedelta(days=days-1)
    labels = [(start+timedelta(days=i)).isoformat() for i in range(days)]; counts = {x:0 for x in labels}; cats={}; platforms={}
    with conn() as c: rows=c.execute("SELECT substr(created_at,1,10) day,category,platform,count(*) total FROM reports WHERE created_at>=? GROUP BY day,category,platform", (start.isoformat()+"T00:00:00Z",)).fetchall()
    for r in rows:
        if r["day"] not in counts: continue
        counts[r["day"]]+=r["total"]; cats[r["category"]]=cats.get(r["category"],0)+r["total"]; platforms[r["platform"]]=platforms.get(r["platform"],0)+r["total"]
    return {"series":[{"date":d,"count":counts[d]} for d in labels], "total":sum(counts.values()),
      "narratives":[{"category":k,"label":CATEGORIES.get(k,k),"count":v} for k,v in sorted(cats.items(),key=lambda x:-x[1])],
      "platforms":[{"platform":k,"count":v} for k,v in sorted(platforms.items(),key=lambda x:-x[1])]}

class App(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, data, typ="application/json; charset=utf-8"):
        raw = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False).encode(); self.send_response(code); self.send_header("Content-Type",typ); self.send_header("Content-Length",str(len(raw))); self.send_header("Access-Control-Allow-Origin","*"); self.send_header("Access-Control-Allow-Headers","Content-Type"); self.send_header("Access-Control-Allow-Methods","GET,POST,OPTIONS"); self.end_headers(); self.wfile.write(raw)
    def do_OPTIONS(self): self.send(204,b"")
    def do_GET(self):
        u=urlparse(self.path); q={k:v[0] for k,v in parse_qs(u.query).items()}
        if u.path=="/": return self.send(200,open(os.path.join(HERE,"kalasag.html"),"rb").read(),"text/html; charset=utf-8")
        if u.path=="/api/status": return self.send(200,{"categories":CATEGORIES,"languages":LANGUAGES})
        if u.path=="/api/submissions":
            with conn() as c: rows=[dict(x) for x in c.execute("SELECT * FROM submissions WHERE status=? ORDER BY created_at DESC",(q.get("status","pending"),))]
            return self.send(200,rows)
        if u.path=="/api/reports":
            with conn() as c: return self.send(200,[dict(x) for x in c.execute("SELECT * FROM reports ORDER BY created_at DESC LIMIT 100")])
        if u.path=="/api/trends": return self.send(200,trends(q.get("days",14)))
        self.send(404,{"error":"Not found"})
    def do_POST(self):
        try:
            u=urlparse(self.path); b=body(self)
            if u.path=="/api/submissions":
                required(b,"term","language","country","explanation")
                with conn() as c:
                    c.execute("INSERT INTO submissions(term,language,country,explanation,selected_text,context_text,source_url,source_title,submitted_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",(b["term"].strip()[:180],b["language"],b["country"],b["explanation"].strip()[:2000],b.get("selected_text","" )[:1200],b.get("context_text","")[:2000],b.get("source_url","")[:2000],b.get("source_title","")[:300],b.get("submitted_by","anonymous")[:120],now())); ident=c.execute("SELECT last_insert_rowid()").fetchone()[0]
                return self.send(201,{"id":ident,"status":"pending"})
            if u.path.startswith("/api/submissions/") and u.path.endswith(("/approve","/reject")):
                required(b,"reviewer"); pieces=u.path.split("/"); ident=int(pieces[3]); decision="approved" if pieces[4]=="approve" else "rejected"
                with conn() as c: c.execute("UPDATE submissions SET status=?,category=?,severity=?,reviewer=?,reviewed_at=? WHERE id=?",(decision,b.get("category","unclassified"),b.get("severity","medium"),b["reviewer"],now(),ident))
                return self.send(200,{"ok":True})
            if u.path=="/api/reports":
                required(b,"matched_text")
                with conn() as c: c.execute("INSERT INTO reports(created_at,url,platform,matched_text,context_text,category,country) VALUES(?,?,?,?,?,?,?)",(now(),b.get("url"),b.get("platform","other"),b["matched_text"][:1000],b.get("context_text","")[:2000],b.get("category","unclassified"),b.get("country","PH")))
                return self.send(201,{"ok":True})
            self.send(404,{"error":"Not found"})
        except (ValueError,KeyError,json.JSONDecodeError) as e: self.send(400,{"error":str(e)})

if __name__=="__main__":
    init(); print("Kalasag website: http://127.0.0.1:8000"); ThreadingHTTPServer(("127.0.0.1",8000),App).serve_forever()
