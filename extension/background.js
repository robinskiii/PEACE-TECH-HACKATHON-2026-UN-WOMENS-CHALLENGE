// Background service worker. Everything that talks to the network happens here:
// the AI endpoint (with key fallback), the Kalasag website, and screenshots.
importScripts("shared.js");

chrome.runtime.onInstalled.addListener(async (details) => {
  await refreshLexicon().catch((e) => console.warn("Word list not loaded:", e.message));
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => refreshLexicon().catch(() => {}));

async function refreshLexicon() {
  const s = await kalasagSettings();
  const url = `${s.serverUrl.replace(/\/+$/, "")}/api/lexicon?country=${encodeURIComponent(s.country)}` +
              `&languages=${encodeURIComponent(s.languages.join(","))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Website replied ${res.status}`);
  const data = await res.json();
  await chrome.storage.local.set({ lexicon: data.entries, lexiconVersion: data.version, lexiconFetchedAt: Date.now() });
  return data.count;
}

async function postReport(s, report) {
  const res = await fetch(`${s.serverUrl.replace(/\/+$/, "")}/api/reports`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Website replied ${res.status}`);
  return data;
}

async function postSubmission(s, submission) {
  const res = await fetch(`${s.serverUrl.replace(/\/+$/, "")}/api/submissions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(submission),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Website replied ${res.status}`);
  return data;
}

async function setAIStatus(status) {
  await chrome.storage.local.set({ aiStatus: { ...status, at: Date.now() } });
}

const legalCache = new Map();

const handlers = {
  // Content script sends a batch of snippets; we return the ones the model flags.
  async classify(msg) {
    const s = await kalasagSettings();
    try {
      const { text, keyUsed } = await kalasagCallModel(s, [
        { role: "system", content: KALASAG_SYSTEM_PROMPT },
        { role: "user", content: kalasagBuildUserMessage(msg.page, msg.items) },
      ]);
      const parsed = kalasagParseJSON(text);
      if (!parsed || !Array.isArray(parsed.flagged)) throw new Error("The model's answer wasn't valid JSON.");
      await setAIStatus({ ok: true, keyUsed });
      return { flagged: parsed.flagged, keyUsed };
    } catch (e) {
      await setAIStatus({ ok: false, error: e.message });
      throw e;
    }
  },

  async testAI() {
    const s = await kalasagSettings();
    const { text, keyUsed } = await kalasagCallModel(s,
      [{ role: "user", content: "Reply with just the word OK." }], { maxTokens: 20, timeoutMs: 30000 });
    await setAIStatus({ ok: true, keyUsed });
    return { reply: text.trim().slice(0, 80), keyUsed };
  },

  // Screenshot the tab, then send the report to the website. If the website is down, keep it for later.
  async saveEvidence(msg, sender) {
    const s = await kalasagSettings();
    let shot = null;
    try {
      shot = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
    } catch (e) {
      console.warn("Screenshot failed:", e.message);
    }
    const report = { ...msg.report, screenshot_b64: shot };
    try {
      const saved = await postReport(s, report);
      return { saved: true, report: saved, hasScreenshot: !!shot };
    } catch (e) {
      const { pending = [] } = await chrome.storage.local.get("pending");
      pending.push({ report, at: Date.now() });
      await chrome.storage.local.set({ pending });
      return { saved: false, queued: true, error: e.message };
    }
  },

  // A user can nominate text the detector did not flag. It goes into the same
  // human-review queue as community submissions, never directly into the list.
  async submitSelection(msg) {
    const s = await kalasagSettings();
    return { submission: await postSubmission(s, {
      ...msg.submission, country: s.country,
      language: msg.submission.language || (s.languages || ["tl"])[0],
    }) };
  },

  async retryPending() {
    const s = await kalasagSettings();
    const { pending = [] } = await chrome.storage.local.get("pending");
    const left = [];
    let sent = 0;
    for (const p of pending) {
      try { await postReport(s, p.report); sent++; } catch { left.push(p); }
    }
    await chrome.storage.local.set({ pending: left });
    return { sent, left: left.length };
  },

  async legalInfo(msg) {
    const s = await kalasagSettings();
    const key = `${msg.country}|${msg.platform}`;
    if (legalCache.has(key)) return legalCache.get(key);
    let info;
    try {
      const res = await fetch(`${s.serverUrl.replace(/\/+$/, "")}/api/legal-info?country=${encodeURIComponent(msg.country)}` +
                              `&platform=${encodeURIComponent(msg.platform)}`);
      if (!res.ok) throw new Error(String(res.status));
      info = await res.json();
      // The website doesn't know every platform; fill in steps we have locally.
      if (msg.platform !== "other" && KALASAG_REPORT_STEPS[msg.platform] && info.platform !== msg.platform) {
        info.report_steps = KALASAG_REPORT_STEPS[msg.platform];
      }
    } catch {
      const base = KALASAG_LEGAL_FALLBACK[msg.country] || KALASAG_LEGAL_FALLBACK.PH;
      info = { ...base, report_steps: KALASAG_REPORT_STEPS[msg.platform] || KALASAG_REPORT_STEPS.other, offline: true };
    }
    legalCache.set(key, { info });
    return { info };
  },

  async refreshLexicon() {
    legalCache.clear();
    return { count: await refreshLexicon() };
  },

  async badge(msg, sender) {
    const n = msg.count || 0;
    await chrome.action.setBadgeText({ tabId: sender.tab.id, text: n ? String(n) : "" });
    await chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#A33A2F" });
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handler = handlers[msg && msg.type];
  if (!handler) return false;
  handler(msg, sender)
    .then((result) => reply({ ok: true, ...result }))
    .catch((e) => reply({ ok: false, error: String(e && e.message || e) }));
  return true; // the reply arrives asynchronously
});

// Re-download the word list when the country or languages change.
chrome.storage.onChanged.addListener((changes) => {
  if (!changes.settings) return;
  const a = changes.settings.oldValue || {}, b = changes.settings.newValue || {};
  if (a.country !== b.country || String(a.languages) !== String(b.languages) || a.serverUrl !== b.serverUrl) {
    refreshLexicon().catch(() => {});
    legalCache.clear();
  }
});
