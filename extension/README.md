# Kalasag browser extension

Flags content that targets women and women leaders on any website, explains why, and lets you save it as evidence to the Kalasag website.

## Install (Chrome, Edge or Brave)

1. Go to `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose this `kalasag-extension` folder.
3. The settings page opens. Paste the shared hackathon key and your team key, then click **Save and test connection**.
4. Start the website (`python app.py` in the `kalasag` folder) and click **Save and download word list**.
5. Pin the Kalasag icon to the toolbar.

After changing any code, click the reload icon on the extension's card in `chrome://extensions`, then refresh the page you're testing.

## How it works

1. **Reading the page.** `content.js` walks the page and splits it into text blocks: posts, comments, headlines, paragraphs. It ignores forms, code, and sites on the "never scan" list (email and private messaging by default).
2. **Word list.** Each block is checked locally against the community word list from the website, including spelling tricks like `1yak1n`. Matches are passed to the AI as hints.
3. **AI check.** In "smart" mode, only blocks that mention women, gendered words or public roles are sent, 12 at a time, to the AI through `background.js`. The model decides from context whether each one targets women, and returns a category, severity, target, the harmful quote and a one-line reason. This is how it catches attacks that aren't in the word list, and avoids flagging fair criticism or news reporting.
4. **Key fallback.** `kalasagCallModel` in `shared.js` does the same as the team's Python `ask()`: shared key first, team key if that's busy, refused or blocked, and the last error if both fail.
5. **Highlights and pop-up.** Flags are drawn in an overlay on top of the page, so the site's own code is never modified. Clicking "Kalasag" opens the pop-up with the reason, legal information and reporting steps from the website, plus **Save as evidence** and **Not harmful**.
6. **Evidence.** Saving takes a screenshot and sends it with the text and link to `POST /api/reports`. If the website is down, the report is kept and can be sent later from the toolbar button.

If there's no key or the AI call fails, word-list matches are still shown with a dashed outline and marked "Word list only".

## Demo script

1. With `app.py` running, open `http://localhost:8000/test-feed`: posts with gendered attacks get flagged; fair criticism and the everyday use of "iyakin" should not.
2. Open `http://localhost:8000/test-article`: the article reporting on abuse stays clean, while the misogynistic comments and the threat are flagged.
3. Try a real news site to show it works anywhere.
4. Click a flag, then **Save as evidence**, and show it arriving on the dashboard's Reports tab.
5. In Settings, switch the role to "I'm the one being targeted" and show flagged content being blurred.

## Files

| File | What it does |
|---|---|
| `manifest.json` | Permissions and file list |
| `shared.js` | Settings, prompt, word matching, AI call with key fallback |
| `background.js` | All network calls: AI, website, screenshots |
| `content.js` | Reads pages, draws highlights and the pop-up |
| `popup.html/js` | Toolbar button: counts, pause on site, refresh, pending reports |
| `options.html/js` | Setup: country, languages, role, keys, scanning |

## Good to know

- Page text is sent to the AI endpoint, so exclude any site you don't want read in Settings.
- The keys are stored in the browser's local extension storage. Never commit them, and don't publish this extension with keys in it.
- The AI can be wrong in both directions. Every flag says why, and "Not harmful" hides it.
