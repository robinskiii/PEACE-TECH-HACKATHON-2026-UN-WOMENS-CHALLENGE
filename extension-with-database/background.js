// =====================================================================
// Reality Check: background service worker
//  * downloads the approved word list + pop-up info from Supabase
//  * runs the optional AI check (so the page never talks to the AI directly)
//  * saves evidence (screenshot + SHA-256 hash) to the backend, or locally
// =====================================================================

importScripts("config.js");

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...RC_CONFIG.DEFAULT_SETTINGS, ...(settings || {}) };
}

// Call a Supabase database function with the publishable key
async function callDatabase(functionName, args) {
  const res = await fetch(`${RC_CONFIG.SUPABASE_URL}/rest/v1/rpc/${functionName}`, {
    method: "POST",
    headers: { apikey: RC_CONFIG.SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(args)
  });
  if (!res.ok) throw new Error(`${functionName} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// Download the approved lexicon for the user's country + languages, and the
// pop-up info (law, reporting links, next steps). Cached, so the extension
// keeps working offline and page text never leaves the computer for matching.
async function refreshAll() {
  const { country, languages } = await getSettings();
  try {
    const [lexicon, popupInfo] = await Promise.all([
      callDatabase("lexicon_export", { p_country: country, p_languages: languages }),
      callDatabase("popup_info", { p_country: country })
    ]);
    await chrome.storage.local.set({
      lexicon,
      popupInfo,
      lexiconStatus: { ok: true, count: lexicon.count, version: lexicon.version, fetchedAt: Date.now(), country, languages }
    });
    console.log(`[Reality Check] loaded ${lexicon.count} words for ${country} (${languages.join(", ")})`);
    return { ok: true, count: lexicon.count };
  } catch (err) {
    console.warn("[Reality Check] refresh failed, keeping cached copy:", err.message);
    const { lexiconStatus } = await chrome.storage.local.get("lexiconStatus");
    await chrome.storage.local.set({ lexiconStatus: { ...(lexiconStatus || {}), ok: false, error: err.message, failedAt: Date.now() } });
    return { ok: false, error: err.message };
  }
}

chrome.runtime.onInstalled.addListener(refreshAll);
chrome.runtime.onStartup.addListener(refreshAll);
chrome.alarms.create("refresh-lexicon", { periodInMinutes: RC_CONFIG.REFRESH_MINUTES });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "refresh-lexicon") refreshAll(); });
chrome.storage.onChanged.addListener((changes) => {
  if (!changes.settings) return;
  const before = changes.settings.oldValue || {};
  const after = changes.settings.newValue || {};
  if (before.country !== after.country || JSON.stringify(before.languages) !== JSON.stringify(after.languages)) {
    refreshAll();
  }
});

// ---------------------------------------------------------------------
// Optional AI check (team's 4 categories)
// ---------------------------------------------------------------------
const AI_SYSTEM_PROMPT = `You classify social media text about women leaders in Asia and the Pacific.
Choose exactly one category and, if it applies, one subtype:
- gender_hate_speech: attacks or degrades a woman specifically through her gender. Subtypes: sexist_insult, sexual_degradation, gender_based_threat, gender_role_attack, dehumanization, gendered_competence_attack, victim_blaming. Key test: is gender the point of the attack? "She is stupid" alone does not count.
- gendered_disinformation: false, misleading or unverified factual claims that use gender, sexuality, family roles or stereotypes to damage her reputation. Subtypes: sexual_rumour, family_rumour, morality_rumour, competence_disinformation, identity_rumour. Never rule on truth; mark verification_needed.
- manipulated_text: real or invented words altered or misused to attack her as a woman. Subtypes: misleading_quote, fabricated_quote, context_manipulation, selective_editing, misleading_framing, false_attribution. Plain political misquotes without a gender angle are out of scope.
- none: criticism of her record, policies or decisions, however harsh, with no gender element.
Mark is_urgent true for threats, doxxing (sharing where she lives) or calls to attack.
Respond ONLY with JSON, no markdown:
{"category":"...","subtype":"... or null","is_urgent":false,"gender_component":true,"factual_claim":false,"manipulation_detected":false,"verification_needed":false,"explanation":"one or two plain sentences for the reader"}`;

async function aiCheck(text) {
  // Preferred: our backend, which keeps the AI key on the server
  if (RC_CONFIG.BACKEND_URL) {
    const res = await fetch(`${RC_CONFIG.BACKEND_URL}/check-context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (!res.ok) throw new Error(`check-context failed (${res.status})`);
    return res.json();
  }
  // Demo shortcut: call the AI directly (see warning in config.js)
  const ai = RC_CONFIG.AI;
  if (!ai.enabled || !ai.apiKey) return { skipped: true };
  const res = await fetch(ai.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ai.apiKey}` },
    body: JSON.stringify({
      model: ai.model,
      temperature: 0.2,
      max_tokens: 300,
      messages: [
        { role: "system", content: AI_SYSTEM_PROMPT },
        { role: "user", content: `Text:\n"""${text.slice(0, 1200)}"""` }
      ]
    })
  });
  if (!res.ok) throw new Error(`AI call failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const raw = (data.choices?.[0]?.message?.content || "").replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------
// Save as evidence: screenshot + SHA-256 hash + link + time
// ---------------------------------------------------------------------
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function dataUrlToBytes(dataUrl) {
  const bin = atob(dataUrl.split(",")[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function saveEvidence(report, tab) {
  const settings = await getSettings();
  const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const bytes = dataUrlToBytes(screenshot);
  const hash = await sha256Hex(bytes);
  const record = {
    ...report,
    url: tab.url,
    country_code: settings.country,
    reporter_role: settings.role,
    screenshot_sha256: hash,
    captured_at: new Date().toISOString()
  };

  if (RC_CONFIG.BACKEND_URL) {
    const form = new FormData();
    form.append("report", JSON.stringify(record));
    form.append("screenshot", new Blob([bytes], { type: "image/png" }), "screenshot.png");
    const res = await fetch(`${RC_CONFIG.BACKEND_URL}/reports`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`Backend refused the report (${res.status})`);
    return { saved: "backend", sha256: hash };
  }

  // No backend yet: keep it on this computer so nothing is lost
  const { evidence = [] } = await chrome.storage.local.get("evidence");
  evidence.push({ ...record, screenshot });
  await chrome.storage.local.set({ evidence });
  return { saved: "local", sha256: hash, total: evidence.length };
}

// ---------------------------------------------------------------------
// Messages from the page and the popup
// ---------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (promise) => {
    promise.then(sendResponse).catch((err) => sendResponse({ error: err.message }));
    return true; // keep the channel open for the async reply
  };
  if (msg.type === "refresh") return reply(refreshAll());
  if (msg.type === "ai-check") return reply(aiCheck(msg.text));
  if (msg.type === "save-evidence") return reply(saveEvidence(msg.report, sender.tab));
  return false;
});
