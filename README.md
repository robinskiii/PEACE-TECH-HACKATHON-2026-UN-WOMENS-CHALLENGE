# Kalasag: protecting women leaders from gendered disinformation

Peace Tech Hackathon 2026, UN Women challenge.

Kalasag has two parts:

- **`extension/`**: a Chrome extension that reads the pages you visit, flags content that targets women and women leaders (using a community word list plus an AI check), explains why, and saves evidence.
- **`website/`**: the partner dashboard and backend: community word database with review, reports from the extension, early-warning alerts when reports about a leader spike, and incident documentation.

## Quick start

1. Start the website: `cd website`, run `python -m pip install -r requirements.txt` once, then `python app.py`. Open http://localhost:8000.
2. Install the extension: `chrome://extensions` → Developer mode → Load unpacked → choose the `extension` folder.
3. In the extension settings, add the AI keys and click "Save and download word list".
4. Open http://localhost:8000/test-feed and http://localhost:8000/test-article.

See `website/README.md` and `extension/README.md` for details.

## Never commit keys

API keys are entered in the extension's settings page and stored only in your browser. Don't paste them into any file in this repo.
