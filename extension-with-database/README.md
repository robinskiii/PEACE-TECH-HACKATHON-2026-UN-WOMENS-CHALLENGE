# Reality Check: browser extension

Flags gendered hate speech and disinformation aimed at women leaders while you browse, explains why a post was flagged, and shows what to do next.

**How it works**
1. It downloads the approved word list for your country and languages from our database, and refreshes it every 6 hours.
2. It checks posts on the page **inside your browser**, so page text is not sent anywhere for this.
3. It adds a badge to each flagged post. Clicking the badge opens a card with:
   - the category and subtype, the meaning of the word, and when it's harmful
   - what to do next (different for the person targeted and for allies)
   - the country's law, where to report, and the platform's reporting link
   - a **Save as evidence** button (screenshot + SHA-256 fingerprint + link + time)
4. **Optional:** posts that mention a watched name but contain no known word (e.g. a fabricated quote) go to an AI check.

| Badge | Meaning |
|---|---|
| Dark red **!** | Urgent: a threat or doxxing |
| Red / orange / yellow **⚠** | High / medium / low severity |
| Purple **AI** | Flagged by the AI check |
| Green **✓** | Checked by AI, no gendered attack found |

---

## Install

1. Open `chrome://extensions` and switch on **Developer mode** (top right).
2. Click **Load unpacked** and choose this folder.
3. Pin **Reality Check** from the puzzle icon, then open it and choose your country, languages and role.
   The status line should show how many words were loaded, e.g. "18 words for PH (en, tl)".

## Try it on the test page

`test-page.html` is a fictional feed of example posts. Open it in either of these ways:

- **Local server (recommended):** run `python -m http.server 8000` in this folder, then open http://localhost:8000/test-page.html
- **As a file:** go to `chrome://extensions` → **Details** on Reality Check → switch on **Allow access to file URLs**, then open the file.

Expected result: 8 posts flagged, "Found where she lives…" marked urgent, and the budget criticism not flagged.

## Settings (`config.js`)

| Setting | What it does |
|---|---|
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | Connection to our database (already filled in). Only ever use the **publishable** key here. |
| `BACKEND_URL` | Our backend, e.g. `http://localhost:8000`. When set, evidence is sent to `POST /reports` and the AI check goes to `POST /check-context`. When empty, evidence is saved on the computer. |
| `AI` | Direct AI connection for testing without a backend (any OpenAI-compatible endpoint). The key is visible to anyone who has the extension, so use a test key only. |
| `WATCHED_NAMES` | Names that trigger the AI check when no known word matches. |
| `DEFAULT_SETTINGS` | Country, languages and role used before the user changes them. |

## Backend endpoints

**`POST /check-context`**
Request: `{"text": "..."}`
Response:
```json
{"category": "manipulated_text", "subtype": "fabricated_quote", "is_urgent": false,
 "gender_component": true, "factual_claim": true, "manipulation_detected": true,
 "verification_needed": true, "explanation": "One or two plain sentences."}
```
`category` is one of `gender_hate_speech`, `gendered_disinformation`, `manipulated_text`, `none`. The prompt the extension uses is `AI_SYSTEM_PROMPT` in `background.js`.

**`POST /reports`** (multipart form)
- `report`: JSON with `url, platform, flagged_text, matched_entry_id, matched_text, category_code, subtype_code, is_urgent, language_code, country_code, reporter_role, classification, screenshot_sha256, captured_at`
- `screenshot`: PNG file

How to store it is described in `../database/README.md`, section 4.

## Files

| File | Job |
|---|---|
| `manifest.json` | Permissions and which scripts run where |
| `config.js` | Settings |
| `background.js` | Downloads the word list and pop-up info, runs the AI check, saves evidence |
| `content.js` | Finds posts, matches words, draws badges and the card |
| `content.css` | Badge and card styles |
| `popup.html`, `popup.js` | Settings popup: on/off, country, languages, role |
| `test-page.html` | Fictional demo feed |

## Troubleshooting

| Problem | Fix |
|---|---|
| No badges on the test page | Use the local server, or switch on **Allow access to file URLs**. |
| Popup says it couldn't update the word list | Check your internet connection and `SUPABASE_URL`. The extension keeps using the last saved list. |
| A word you added isn't flagged | It must be **approved** in the database. Then click **Update word list now** in the popup. |
| "Extension was reloaded. Refresh the page." | Reload the web page after reloading the extension. |
