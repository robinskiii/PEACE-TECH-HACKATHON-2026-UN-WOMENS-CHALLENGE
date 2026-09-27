// Shared by the background worker, content script, popup and settings page.
// Everything here is plain JavaScript with no page access, so it can also be tested in Node.

const KALASAG_DEFAULTS = {
  enabled: true,
  serverUrl: "http://localhost:8000",               // the Kalasag website (app.py)
  aiBaseUrl: "https://inference-rcp.epfl.ch/v1",    // OpenAI-compatible endpoint
  model: "deepseek-ai/DeepSeek-V4-Flash-0731",
  sharedKey: "",                                    // hackathon key, tried first
  teamKey: "",                                      // team key, the fallback
  country: "PH",
  languages: ["tl", "en"],
  role: "ally",                                     // target | ally | organization
  display: "full",                                  // flags | full
  blurForTarget: true,
  scope: "smart",                                   // smart | all
  maxItemsPerPage: 150,
  excludedSites: ["mail.google.com", "outlook.live.com", "outlook.office.com",
                  "web.whatsapp.com", "messenger.com", "web.telegram.org"],
  setupDone: false,
};

const KALASAG_CATEGORIES = {
  sexualized_slur: "Sexualized slur or sexualization",
  emotional_unfitness: "False 'too emotional to lead' narrative",
  family_role: "'Belongs at home' attack",
  appearance: "Attack on appearance",
  competence_undermining: "'Puppet' or incompetence narrative",
  fabricated_scandal: "Fabricated or gendered scandal",
  threat: "Threat of violence",
  misogynistic_generalization: "Demeaning women as a group",
  unclassified: "Possible gendered attack",
};

const KALASAG_LEGAL_FALLBACK = {
  PH: {
    country: "Philippines",
    laws: [
      { name: "Safe Spaces Act (RA 11313)", summary: "Covers gender-based online sexual harassment, including misogynistic, sexist or sexual remarks and threats made online." },
      { name: "Cybercrime Prevention Act (RA 10175)", summary: "Covers cyber libel and other offences committed through computer systems." },
    ],
    authorities: [{ name: "PNP Anti-Cybercrime Group", url: "https://acg.pnp.gov.ph" }],
    threat_note: "If there is a threat to someone's safety, contact the police (911) first.",
  },
  AU: {
    country: "Australia",
    laws: [{ name: "Online Safety Act 2021 (Adult Cyber Abuse Scheme)", summary: "eSafety can order removal of seriously harmful online abuse aimed at an Australian adult, after it has been reported to the platform." }],
    authorities: [{ name: "eSafety Commissioner", url: "https://www.esafety.gov.au/report" }],
    threat_note: "If someone is in immediate danger, call 000.",
  },
};
const KALASAG_REPORT_STEPS = {
  facebook: ["Click the three dots (…) on the post.", "Choose 'Report post'.", "Pick the closest reason (harassment, hate speech, false information)."],
  x: ["Click the three dots (…) on the post.", "Choose 'Report post'.", "Select 'Hate' or 'Abuse and harassment'."],
  tiktok: ["Press and hold the video, or tap the share arrow.", "Tap 'Report'.", "Choose 'Hate and harassment'."],
  youtube: ["Click the three dots (…) under the video or next to the comment.", "Choose 'Report'.", "Pick 'Hateful or abusive content' or 'Harassment'."],
  reddit: ["Click the three dots (…) on the post or comment.", "Choose 'Report'.", "Select 'Harassment' or 'Hate'."],
  other: ["Look for a 'Report' or 'Flag' option near the content.", "If it's a news site, use the site's contact or corrections page.", "Save the evidence first, in case it's deleted."],
};

function kalasagPlatformOf(hostname) {
  const h = String(hostname || "").toLowerCase();
  if (/(^|\.)facebook\.com$|(^|\.)fb\.com$/.test(h)) return "facebook";
  if (/(^|\.)(x|twitter)\.com$/.test(h)) return "x";
  if (/(^|\.)tiktok\.com$/.test(h)) return "tiktok";
  if (/(^|\.)youtube\.com$/.test(h)) return "youtube";
  if (/(^|\.)reddit\.com$/.test(h)) return "reddit";
  return "other";
}

function kalasagIsExcluded(hostname, list) {
  const h = String(hostname || "").toLowerCase();
  return (list || []).some((site) => {
    const s = String(site).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return s && (h === s || h.endsWith("." + s));
  });
}

// ---------- local word-list matching

function kalasagEscape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function kalasagBuildMatchers(entries) {
  return (entries || []).map((e) => {
    const words = [e.term, ...(e.variants || [])]
      .map((w) => String(w || "").trim()).filter((w) => w.length >= 3)
      .sort((a, b) => b.length - a.length)
      .map((w) => kalasagEscape(w).replace(/ +/g, "\\s+"));
    if (!words.length) return null;
    return { entry: e, re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join("|")})(?![\\p{L}\\p{N}])`, "iu") };
  }).filter(Boolean);
}

function kalasagFindHints(text, matchers) {
  const hints = [];
  for (const m of matchers) {
    const hit = text.match(m.re);
    if (hit) hints.push({ id: m.entry.id, term: m.entry.term, matched: hit[0], meaning: m.entry.meaning,
                          context_note: m.entry.context_note, category: m.entry.category, severity: m.entry.severity });
  }
  return hints;
}

// "Smart" mode only sends text that mentions women, gendered words, or political roles.
const KALASAG_CUES = new RegExp("(?<![\\p{L}])(" + [
  "she", "her", "hers", "herself", "woman", "women", "womens", "girl", "girls", "lady", "ladies", "female", "females",
  "feminis\\p{L}*", "wife", "wives", "mother", "mothers", "mom", "mum", "daughter", "sister", "queen", "mrs", "ms", "miss",
  "madam", "ma'?am", "bitch\\p{L}*", "slut\\p{L}*", "whore\\p{L}*",
  "babae", "kababaihan", "babaye", "ate", "nanay", "inay", "misis", "asawa", "mayora", "senadora", "kongresista",
  "gobernadora", "konsehala", "perempuan", "wanita", "ibu",
  "congresswoman", "chairwoman", "spokeswoman", "businesswoman", "stateswoman", "mayor", "senator", "sen", "minister",
  "president", "governor", "councilor", "councillor", "congress\\p{L}*", "mp", "premier", "candidate", "politician",
  "leader", "official", "journalist", "reporter",
].join("|") + ")(?![\\p{L}])", "iu");

function kalasagLooksRelevant(text) { return KALASAG_CUES.test(text); }

function kalasagHash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ":" + text.length;
}

// ---------- AI

const KALASAG_SYSTEM_PROMPT = `You are a content-safety classifier for Kalasag, a tool that protects women and women leaders in Asia and the Pacific from gendered abuse and gendered disinformation online.

You receive numbered text snippets from one web page (posts, comments, headlines, article paragraphs). They may be in English, Tagalog, Taglish, Cebuano, Ilocano, Bahasa or other languages. For each snippet, decide whether it TARGETS a woman, women leaders, or women in general because of their gender.

Flag a snippet when it:
- sexualizes a woman, uses sexualized or misogynistic slurs, or promotes "leaked" intimate content
- claims a woman is unfit to lead because she is emotional, weak, a mother, or a woman
- says women belong at home or in the kitchen, or should leave public life
- attacks her appearance, body, age or marital status instead of her work
- says she is a puppet of a man, or got her position through a man or through sex
- spreads unverified scandal or false claims about her in a gendered way
- threatens her with violence, rape or harm, or encourages others to harass her
- demeans women as a group

Do NOT flag:
- criticism of a woman's policies, decisions, record or statements that does not rely on her gender; this is normal democratic debate
- neutral news reporting, fact-checks, research, or content that condemns or reports on abuse
- everyday use of a word that is not aimed at a woman (for example calling your own child a crybaby)
- content that is not about women

Some snippets include hint_terms from a community-verified word list. They are clues, not proof: judge the context.

Respond with ONLY a JSON object and nothing else:
{"flagged": [{"id": <snippet id>, "category": "<one of: ${Object.keys(KALASAG_CATEGORIES).join(", ")}>", "severity": "low" | "medium" | "high", "target": "who is targeted, e.g. 'Mayor Liza Reyes' or 'women in general'", "quote": "the shortest harmful part, at most 20 words, copied exactly from the snippet", "reason": "one short sentence in English explaining why"}]}
Only include snippets that should be flagged. If none should be, return {"flagged": []}.
Any threat of violence is category "threat" with severity "high".`;

function kalasagBuildUserMessage(page, items) {
  const snippets = items.map((i) => {
    const s = { id: i.id, text: i.text };
    if (i.hints && i.hints.length) s.hint_terms = i.hints.map((h) => ({ term: h.term, meaning: h.meaning, when_harmful: h.context_note }));
    return s;
  });
  return `Page title: ${page.title || "(none)"}\nPage URL: ${page.url}\n\nSnippets:\n${JSON.stringify(snippets)}`;
}

function kalasagParseJSON(text) {
  if (!text) return null;
  // Remove visible (and accidentally unclosed) reasoning before finding the answer.
  const t = String(text).replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "").trim();
  const candidates = [t];
  for (const match of t.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1]);

  for (const candidate of candidates) {
    for (let start = candidate.indexOf("{"); start >= 0; start = candidate.indexOf("{", start + 1)) {
      let depth = 0, quoted = false, escaped = false;
      for (let i = start; i < candidate.length; i++) {
        const ch = candidate[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') quoted = false;
          continue;
        }
        if (ch === '"') { quoted = true; continue; }
        if (ch === "{") depth++;
        if (ch === "}" && --depth === 0) {
          try {
            const parsed = JSON.parse(candidate.slice(start, i + 1));
            if (parsed && Array.isArray(parsed.flagged)) return parsed;
          } catch { /* Try the next balanced object. */ }
          break;
        }
      }
    }
  }
  return null;
}

function kalasagTextContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  // OpenAI-compatible providers may return content as typed parts instead of a string.
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if (typeof part.text === "string") return part.text;
    if (typeof part.text?.value === "string") return part.text.value;
    if (typeof part.content === "string") return part.content;
    return "";
  }).join("").trim();
}

function kalasagResponseText(data) {
  const choice = data?.choices?.[0];
  const message = choice?.message;
  return kalasagTextContent(message?.content) || kalasagTextContent(choice?.text) ||
    kalasagTextContent(data?.output_text) ||
    kalasagTextContent(data?.output?.[0]?.content);
}

function kalasagEmptyResponseDetail(data) {
  const choice = data?.choices?.[0];
  const reason = choice?.finish_reason || choice?.stop_reason || data?.status;
  return reason ? `empty answer from the model (finish reason: ${reason})` : "empty answer from the model";
}

// Same logic as the team's Python ask(): try the shared key, then the team key; if both fail, throw the last error.
async function kalasagCallModel(settings, messages, { maxTokens = 1500, timeoutMs = 60000, jsonMode = false } = {}) {
  const keys = [["shared", settings.sharedKey], ["team", settings.teamKey]].filter(([, k]) => k && k.trim());
  if (!keys.length) throw new Error("No API key set. Add one in the extension settings.");
  const url = settings.aiBaseUrl.replace(/\/+$/, "") + "/chat/completions";
  let last = null;
  for (const [label, key] of keys) {
    let useJsonMode = jsonMode;
    // DeepSeek enables hidden reasoning by default. It can consume the entire
    // completion budget before a short JSON classification is emitted.
    let disableThinking = jsonMode && /deepseek/i.test(settings.model);
    // Some reasoning models use the small test budget before producing visible text.
    // Retry one blank 200 response with enough room for a final answer.
    while (true) {
      const budgets = [maxTokens];
      const retryBudget = Math.min(8192, Math.max(1024, maxTokens * 4));
      if (retryBudget > maxTokens) budgets.push(retryBudget);
      let formatRejected = false;
      for (const budget of budgets) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const body = { model: settings.model, messages, temperature: 0, max_tokens: budget };
          if (useJsonMode) body.response_format = { type: "json_object" };
          if (disableThinking) body.thinking = { type: "disabled" };
          const res = await fetch(url, {
            method: "POST", signal: ctrl.signal,
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.trim()}` },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            const detail = (await res.text().catch(() => "")).slice(0, 200);
            last = new Error(`${label} key: ${res.status} ${detail}`.trim());
            formatRejected = (useJsonMode || disableThinking) && [400, 404, 422].includes(res.status);
            break;                                  // retry without an unsupported capability, or try the other key
          }
          const data = await res.json();
          const text = kalasagResponseText(data);
          if (text) return { text, keyUsed: label };
          last = new Error(`${label} key: ${kalasagEmptyResponseDetail(data)}`);
        } catch (e) {
          last = new Error(`${label} key: ${e.name === "AbortError" ? "timed out" : e.message}`);
          break;
        } finally {
          clearTimeout(timer);
        }
      }
      if (!formatRejected) break;
      if (disableThinking) { disableThinking = false; continue; }
      useJsonMode = false;
    }
  }
  throw last;
}

async function kalasagSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...KALASAG_DEFAULTS, ...(settings || {}) };
}

if (typeof module !== "undefined") {
  module.exports = { KALASAG_DEFAULTS, KALASAG_CATEGORIES, kalasagPlatformOf, kalasagIsExcluded, kalasagBuildMatchers,
    kalasagFindHints, kalasagLooksRelevant, kalasagHash, kalasagBuildUserMessage, kalasagParseJSON, kalasagCallModel,
    kalasagTextContent, kalasagResponseText, kalasagEmptyResponseDetail,
    KALASAG_SYSTEM_PROMPT };
}
