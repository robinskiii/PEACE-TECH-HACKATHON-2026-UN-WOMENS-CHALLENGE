# Reality Check extension v2: connected to our database

This keeps the idea of the first version (a badge on each post and an explanation card) and connects it to our Supabase database:

- **Words come from the database**, not from code. The extension downloads the approved word list for the user's country and languages, and checks pages **locally**, so page text never leaves the computer for this.
- **The card shows our real content:** the category and subtype from our guide, the meaning and context note, "what to do next" steps (different for the target and for allies), the country's law and where to report, and the platform's reporting link.
- **Urgent posts** (threats, doxxing) get a dark red "!" badge and the urgent steps.
- **Save as evidence** takes a screenshot, computes its SHA-256 fingerprint, and sends it to the backend. Until the backend exists, it saves the evidence on the computer so nothing is lost.
- **There's no AI key in the page code any more.** The AI check is optional and runs from the background script. Once the backend exists, it goes through the backend.

## Install (2 minutes)

1. Open `chrome://extensions` and switch on **Developer mode** (top right).
2. If the old version is installed, remove it. Then click **Load unpacked** and choose this folder.
3. Click the puzzle icon and pin **Reality Check**. Open it to pick your country, languages and role. It should say "18 words for PH (en, tl)".

## Try it on the test page

Choose one:
- **Easiest:** in a terminal in this folder, run `python -m http.server 8000`, then open http://localhost:8000/test-page.html
- **Or open the file directly:** go to `chrome://extensions`, click **Details** on Reality Check, and switch on **Allow access to file URLs**. Without this, Chrome won't run extensions on `file://` pages, which is why nothing showed up before.

What you should see: 8 posts flagged. "Found where she lives…" is urgent. The budget criticism is **not** flagged. The fabricated quote is only caught when the AI check is on.

## Settings (`config.js`)

| Setting | What it's for |
|---|---|
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | Already filled in. The publishable key is safe to ship. **Never** put the secret key here. |
| `BACKEND_URL` | Our FastAPI server, e.g. `http://localhost:8000`. When set, evidence goes to `POST /reports` and the AI check goes to `POST /check-context`. |
| `AI` | A shortcut for the demo only: calls an OpenAI-compatible AI directly. Anyone who installs the extension can read this key, so use a throwaway key with a spending limit, and turn it off once the backend works. For a model name like `deepseek-ai/DeepSeek-V4-Flash-0731`, use the endpoint and model name from whichever provider issued that key. |
| `WATCHED_NAMES` | Names that trigger the AI check when no word matches (e.g. fabricated quotes). |

If a real API key was ever put into the old `content.js` and shared, create a new key and delete the old one.

## What the backend needs to provide

**`POST /check-context`**, body `{"text": "..."}`, returns:
```json
{"category": "manipulated_text", "subtype": "fabricated_quote", "is_urgent": false,
 "gender_component": true, "factual_claim": true, "manipulation_detected": true,
 "verification_needed": true, "explanation": "One or two plain sentences."}
```
`category` is one of `gender_hate_speech`, `gendered_disinformation`, `manipulated_text`, `none`. The prompt is in `background.js` (`AI_SYSTEM_PROMPT`).

**`POST /reports`**, multipart form with:
- `report`: JSON using the same field names as the `reports` table: `url, platform, flagged_text, matched_entry_id, matched_text, category_code, subtype_code, is_urgent, language_code, country_code, reporter_role, classification, screenshot_sha256, captured_at`
- `screenshot`: the PNG

The backend should re-compute the SHA-256 of the PNG and check that it matches, upload it to the `report-screenshots` bucket, and insert the row (see `database/README.md`, section 3).

## Files

| File | Job |
|---|---|
| `manifest.json` | Permissions and which scripts run where |
| `config.js` | Settings (above) |
| `background.js` | Downloads the word list and pop-up info, runs the AI check, saves evidence |
| `content.js` | Finds posts, matches words, draws badges and the card |
| `content.css` | Badge and card styles |
| `popup.html` / `popup.js` | Settings: on/off, country, languages, role, word-list status |
| `test-page.html` | Fictional demo feed |
