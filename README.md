# Kalasag

Kalasag is a prototype for helping women leaders and the organizations around them recognize, document, and respond to gendered hate speech and disinformation online. It combines a browser extension with a shared monitoring and evidence workspace.

> **Prototype status.** Kalasag ships with fictional people, posts, and placeholder terms for demonstration. It is not yet a production incident-management or emergency-response service.

## Problem

For women in public life, online abuse is often more than ordinary disagreement. It can be a coordinated mix of sexualized insults, gender stereotypes, fabricated scandals, threats, and claims that a woman is too emotional, incompetent, or controlled by a man to lead. Its purpose can be to discredit women’s work and make public participation feel unsafe. UN Women’s South-East Asia research identifies trolling, online hate speech, disinformation and slander campaigns among the digital-security risks facing women, and describes systematic online attacks as a barrier to equality, human rights, and inclusive peace. [UN Women, 2024](https://asiapacific.unwomen.org/en/stories/press-release/2024/10/un-women-research-recommends-strategies-to-advance-the-women-peace-and-security-agenda-in-the-digital-space)

The evidence gap makes response harder. Harmful posts can be deleted, reports can be scattered across platforms, and the pattern behind a campaign is difficult to see one screenshot at a time. Under-reporting is also substantial: UN Women reports that only one in four women reports online violent acts to the platform where they occurred, and fewer report them to a protective agency. [UN Women explainer](https://www.unwomen.org/en/articles/explainer/power-on-how-we-can-supercharge-an-equitable-digital-future)

Automated moderation does not solve this on its own. Models may miss local language, Taglish/code-switching, morphology, euphemisms, altered spellings, and fast-changing community slang—or misclassify legitimate policy criticism and reporting on abuse. Recent Filipino-language evaluations find that Filipino remains underrepresented in pre-training data and that leading models still have notable reading-comprehension and translation gaps across Filipino, Tagalog, and Cebuano. [Batayan](https://aclanthology.org/2025.acl-long.1509/), [FilBench](https://aclanthology.org/2025.emnlp-main.127/). Kalasag treats AI as a contextual aid, not an authority, and keeps community validation and expert review in the loop.

## Solution / product presentation

Kalasag supports two connected experiences.

### Browser extension: make a decision while you are on the page

1. Choose a country, the languages you read, and whether you are the target, an ally, or part of an organization. A targeted user can have flagged content blurred by default.
2. Browse normally. Kalasag checks text blocks such as posts, comments, and paragraphs. It recognizes verified local terms—including configured spelling variants—then uses an LLM to assess the surrounding context.
3. When content is flagged, open the marker to see the category, severity, short explanation, relevant reporting steps, and available legal information. Fair criticism, neutral reporting, and everyday uses of a word are deliberately meant to remain unflagged.
4. Select **Save as evidence** to capture the visible page. The saved screenshot is stamped with its URL and UTC time, fingerprinted with SHA-256, and sent to the Kalasag workspace. If the workspace cannot be reached, the extension keeps the report locally so it can be sent later.
5. If something was missed, select it, right-click, and choose **Report to Kalasag**. Add an optional note and send it for expert review.

The extension does **not** submit a complaint to a platform, police, or other authority. It preserves evidence and gives reporting guidance so a person or partner organization can decide the next step.

### Kalasag website: turn individual reports into usable evidence

The website is the partner workspace behind the extension:

- **Evidence vault:** keeps submitted reports, context, source links, screenshots, and immutable fingerprints; it also records incidents with optional attachments.
- **Community lexicon:** collects new terms and variants, drafts supporting fields with optional AI help, and requires a reviewer to approve a term before the extension receives it.
- **Review queue:** reports found only by the AI or submitted from a user highlight stay pending until an expert approves or rejects them. Reports matched to an already approved lexicon entry are accepted immediately.
- **Trends and early warning:** shows the narratives, platforms, and leaders appearing in approved reports. A spike alert is created when the last 24 hours has at least five reports and is at least three times the prior seven-day daily baseline; alerts are rate-limited to one per leader every six hours.

The goal is a feedback loop: local communities improve the vocabulary, context-aware classification finds more than a word list alone, reviewers protect the data quality, and the aggregate view helps partners recognize changing narratives and unusual activity sooner.

## Quick start

### 1. Start the website

Kalasag needs Python 3.9 or newer. The default setup is local and needs no database account.

```bash
cd website
python -m pip install -r requirements.txt
python app.py
```

Open [http://localhost:8000](http://localhost:8000). On its first run, the app creates `website/kalasag.db` and seeds demo data.

To use a shared Supabase database instead, run [`database/schema.sql`](database/schema.sql) in the Supabase SQL Editor, copy `website/.env.example` to `website/.env`, add `SUPABASE_URL` and `SUPABASE_SECRET_KEY`, then start the website. The secret key belongs only in the server’s local environment; the browser extension never talks to Supabase directly.

### 2. Install the extension

1. In Chrome, Edge, or Brave, open `chrome://extensions`.
2. Enable **Developer mode**, click **Load unpacked**, and select the [`extension`](extension) folder.
3. Open the extension’s settings page. Set the website address (the default is `http://localhost:8000`) and choose **Save and download word list**.
4. To use contextual AI classification, enter the OpenAI-compatible endpoint, model, and at least one API key, then choose **Save and test connection**. Without an AI key, verified word-list matches still appear as “Word list only.”
5. Pin Kalasag to the toolbar. After changing extension code, use the reload button on its `chrome://extensions` card and refresh the page you are testing.

### 3. Try the full flow

1. Visit [http://localhost:8000/test-feed](http://localhost:8000/test-feed). Gendered attacks should be marked; policy criticism and an everyday use of `iyakin` should not.
2. Open [http://localhost:8000/test-article](http://localhost:8000/test-article). The abuse in the comments should be marked, while the article’s reporting should remain clear.
3. Save a flagged item as evidence and confirm it appears under **Reports** on the dashboard.
4. Highlight another passage, right-click **Report to Kalasag**, save it, and approve or reject it from the pending review queue.

For a focused setup and user guide, see [extension/README.md](extension/README.md) and [website/README.md](website/README.md).

## Overview

```text
Web page
  │
  ├─ Extension splits readable content into posts, comments, headlines, and paragraphs
  ├─ Approved lexicon is matched locally (term + spelling variants)
  ├─ Relevant snippets and lexicon hints are sent in small batches to the configured LLM API
  └─ Contextual flags are shown as a page overlay; the site’s own HTML is not changed
       │
       └─ Save evidence / report a selection
            │
            ▼
Kalasag website API
  ├─ hashes and stores the screenshot, context, URL, and metadata
  ├─ matches named leaders from their registered names and variants
  ├─ sends AI-only and user-highlighted reports to expert review
  ├─ aggregates approved reports into trends and spike alerts
  └─ serves approved community terms back to extensions
            │
            ▼
SQLite locally, or Supabase for a shared deployment
```

More precisely, the lexicon is stored in SQLite by default or in Supabase when configured. The extension downloads only approved terms for its selected country and languages, and matches them in the browser. Word hits are *hints*, not a verdict. In smart mode, the extension sends only snippets with women-, gender-, or public-role cues to the configured LLM; all-text mode is available when broader checking is needed. The LLM returns a category, severity, target, harmful quote, and explanation. It is also instructed to preserve democratic criticism and reporting about abuse.

The browser keeps its settings, downloaded lexicon, and unsent reports in extension-local storage. API keys remain there; text sent for AI classification goes to the configured API provider. The server stores evidence through its storage backend and exposes a local demo API without user authentication. Consequently, this repository is suitable for a hackathon/demo environment only. A real deployment needs authentication and roles, HTTPS, access controls around evidence and incidents, retention and consent policies, jurisdiction-specific legal review, and a privacy/security assessment.

## Repository guide

| Location | Purpose |
|---|---|
| [`extension/`](extension) | Manifest V3 browser extension: scanning, contextual classification, overlays, evidence capture, and settings. |
| [`website/`](website) | Python dashboard and API: lexicon review, evidence, reports, trends, alerts, incidents, and demo pages. |
| [`database/`](database) | Supabase schema, report-review migration, and the source community word list. |
| [`test_articles/`](test_articles) | Standalone article fixtures for manual extension testing. |

## Credits

Built for the UN Women Peace Tech Hackathon 2026 challenge.

Add the team members and partner organizations here.
