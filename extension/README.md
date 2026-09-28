# Kalasag browser extension

The Kalasag extension helps a person recognize potential gendered abuse or disinformation while reading a web page, understand why it was flagged, and preserve a visible-page screenshot as evidence. It is designed to work with the [Kalasag website](../website/README.md), which supplies the approved community lexicon and receives reports.

## User experience

### Set up once

In **Settings**, a person chooses their country and reading languages, and says whether they are the person being targeted, an ally, or working for an organization. Targets can choose to blur flagged content until they actively reveal it. Settings also offer a concise explanation only or the full view with legal and platform-reporting guidance.

They then download the approved word list for their country and languages from the Kalasag website. Context-aware classification is optional but needs an OpenAI-compatible LLM endpoint, model, and one or two API keys. The extension tries the shared key first, then the team key if the first is unavailable.

### Browse and understand a flag

On a normal web page, Kalasag reads visible text in posts, comments, headings, and paragraphs; it does not alter the page’s own HTML. It draws an overlay around text that needs attention. Selecting the marker shows:

- the type and severity of the possible attack;
- a short explanation and the relevant harmful passage;
- reporting instructions for the current platform;
- available country-specific legal information and, for threats, an immediate-safety note.

The user can mark a result **Not harmful**. The classifier is explicitly instructed to leave ordinary policy criticism, neutral news, fact-checks, and harmless everyday language unflagged.

### Preserve evidence or report a missed item

Choose **Save as evidence** on a flag to capture the current visible tab. Kalasag adds the URL and UTC time to the screenshot, sends it with the text and page metadata to the website, and displays a portion of its SHA-256 fingerprint. If the website cannot be reached, it retains the report in browser storage; the toolbar popup offers to send pending reports later.

For content Kalasag did not flag, select the text, right-click, and choose **Report to Kalasag**. The user can choose a category or leave it for an expert, add an explanatory note, and save evidence. A highlighted report and an AI-only report are pending until an expert reviewer approves them. A report backed by an already approved word-list entry is accepted immediately.

Kalasag preserves material and explains reporting paths; it does not submit a complaint to platforms or public authorities on the user’s behalf.

## Install and connect

1. Start the website first. From the repository root:

   ```bash
   cd website
   python -m pip install -r requirements.txt
   python app.py
   ```

2. In Chrome, Edge, or Brave, go to `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select this `extension` folder.
3. The settings page opens after installation. Set the **Website address** (normally `http://localhost:8000`) and choose **Save and download word list**.
4. To enable contextual classification, enter an OpenAI-compatible endpoint, a model, and at least one API key, then select **Save and test connection**.
5. Pin the extension and open [the test feed](http://localhost:8000/test-feed).

After changing extension code, use the reload icon on its `chrome://extensions` card, then refresh the page. To scan a `file://` fixture, enable **Allow access to file URLs** in the extension’s Details page. Browser-internal pages and the Chrome Web Store cannot be scanned.

## How the extension works

1. `content.js` collects visible, readable blocks (up to 1,200 characters each), ignoring inputs, editable fields, code, scripts, and other non-reading UI. It watches for newly loaded feed content as well.
2. It compares each block locally with the downloaded, reviewer-approved lexicon, including configured spelling variants. It does not send the entire word list to the model.
3. In the default **smart** scope, only blocks with a lexicon hit or a cue related to women, gender, or public roles are candidates for AI review. **All text** can be selected in Settings when broader scanning is appropriate. The configurable page cap is 150 snippets by default.
4. Candidate blocks are sent to the configured API in batches of 12. The prompt supplies the page URL/title and any word-list hits as context; it asks the model for only confirmed flags, with category, severity, target, quote, and reason.
5. If no API key is configured or an AI call fails, verified word-list hits remain visible with a dashed **Word list only** marker. They have not received contextual AI review.
6. The overlay and popup let the person dismiss a flag, pause scanning on the current site, rescan, refresh the lexicon, or send queued reports.

## Privacy and operating boundaries

- The extension has `<all_urls>` host permission so it can scan pages people choose to visit. It does not run on browser-protected pages.
- In smart mode, only candidate snippets are sent to the configured LLM provider; all-text mode sends more of the page. Do not scan pages whose content should not leave the browser.
- Email and private-messaging sites are excluded by default. Add any other site to **Never scan these sites** in Settings.
- Browser settings, API keys, the downloaded lexicon, and pending reports are stored in Chrome extension-local storage. The model provider and its data practices are determined by the endpoint configured in Settings.
- Screenshots are of the currently visible tab, not a full-page capture. This is a demo prototype; see the root README for production requirements.

## Try the demo

1. Open [test-feed](http://localhost:8000/test-feed). Gendered attacks should be flagged, while fair criticism and the everyday use of `iyakin` should stay clear.
2. Open [test-article](http://localhost:8000/test-article). The article’s reportage should not be flagged; abusive comments and the threat should be.
3. Save a flag, then find it under **Reports** on the website.
4. Highlight a missed passage, use **Report to Kalasag**, and then approve or reject it under **Waiting for review**.
5. Set your role to **I’m the one being targeted** to see the optional content blur.

## File guide

| File | Responsibility |
|---|---|
| `manifest.json` | Manifest V3 permissions, extension entry points, and content-script matches. |
| `shared.js` | Defaults, local matching, relevance cues, classifier prompt/parser, and API-key fallback. |
| `content.js` | Page reading, scanning, flag overlays, content blur, the evidence panel, and manual highlighting. |
| `background.js` | Model and website requests, screenshot stamping, retries, legal-info caching, and context-menu setup. |
| `options.html` / `options.js` | User settings and connection tests. |
| `popup.html` / `popup.js` | Toolbar controls, scan status, lexicon refresh, and pending-report retry. |
