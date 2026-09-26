# Backend (FastAPI): to be built

The endpoints the extension and website need are described in:
- `../extension/README.md` → `POST /reports` and `POST /check-context`
- `../database/README.md` → section 3 (what to call in Supabase for each endpoint)

Setup: copy `.env.example` to `.env` and fill in the keys. `.env` is git-ignored, so keys never get committed.

Note: the extension reads the word list directly from Supabase with the public key,
so the backend does not need a `GET /lexicon` endpoint.
