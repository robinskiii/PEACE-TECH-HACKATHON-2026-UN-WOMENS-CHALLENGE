const EXTENSION_ROOT_ATTRIBUTE = "data-reality-check-root";
const FLAG_ATTRIBUTE = "data-reality-check-flagged";
const ID_ATTRIBUTE = "data-reality-check-id";
const HASH_ATTRIBUTE = "data-reality-check-hash";
const MAX_SEGMENTS_PER_SCAN = 18;
const MAX_CANDIDATES_PER_SCAN = 80;
const MIN_TEXT_LENGTH = 80;
const MAX_TEXT_LENGTH = 1500;

const state = {
  analysisById: new Map(),
  analyzedHashes: new Set(),
  scanTimer: null,
  scanInFlight: false,
  pendingScan: false,
  bannerKey: null
};

const BLOCK_TAGS = new Set([
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DIV",
  "FIGCAPTION",
  "H1",
  "H2",
  "H3",
  "H4",
  "LI",
  "MAIN",
  "P",
  "SECTION",
  "TD",
  "TH"
]);

const HIGH_PRIORITY_PATTERNS = [
  /\b(president|prime minister|minister|senator|governor|mayor|ceo|chief|director|editor|leader|chair|secretary|judge|ambassador|journalist|activist)\b/i,
  /\b(woman|women|female|girl|girls|she|her)\b/i,
  /\b(hysterical|emotional|bossy|shrill|bimbo|witch|slept her way|too pretty|too ugly|unfit|lying|hoax|fake)\b/i
];

init();

function init() {
  injectStyles();
  bindRuntimeEvents();
  bindPageEvents();
  scheduleScan(700);
}

function bindRuntimeEvents() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "REALITY_CHECK_RESCAN") {
      clearBanner();
      scheduleScan(100);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "REALITY_CHECK_CLEAR") {
      clearHighlights();
      clearBanner();
      closeDetailPanel();
      sendResponse({ ok: true });
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }

    if (changes.enabled && changes.enabled.newValue === false) {
      clearHighlights();
      clearBanner();
      closeDetailPanel();
      return;
    }

    if (changes.enabled || changes.apiKey || changes.apiEndpoint || changes.model) {
      clearBanner();
      scheduleScan(150);
    }
  });
}

function bindPageEvents() {
  document.addEventListener("click", handleFlagClick, true);

  const observer = new MutationObserver(() => {
    scheduleScan(1200);
  });

  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => scheduleScan(100), { once: true });
  }
}

function handleFlagClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) {
    return;
  }

  if (target.closest(`[${EXTENSION_ROOT_ATTRIBUTE}="true"]`)) {
    return;
  }

  const flaggedElement = target.closest(`[${FLAG_ATTRIBUTE}="true"]`);
  if (!flaggedElement) {
    return;
  }

  const analysisId = flaggedElement.getAttribute(ID_ATTRIBUTE);
  const analysis = state.analysisById.get(analysisId);
  if (!analysis) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  openDetailPanel(analysis, flaggedElement);
}

function scheduleScan(delayMs) {
  window.clearTimeout(state.scanTimer);
  state.scanTimer = window.setTimeout(() => {
    void runScan();
  }, delayMs);
}

async function runScan() {
  if (state.scanInFlight) {
    state.pendingScan = true;
    return;
  }

  state.scanInFlight = true;

  try {
    const enabled = await getStoredValue("enabled", true);
    if (!enabled) {
      return;
    }

    const segments = collectSegments();
    if (!segments.length) {
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: "REALITY_CHECK_ANALYZE",
      payload: {
        page: {
          title: document.title,
          url: location.href
        },
        segments
      }
    });

    if (!response?.ok) {
      handleAnalysisError(response?.error || "Analysis failed.");
      return;
    }

    clearBanner();
    applyAnalysisResults(response.results || [], segments);
  } catch (error) {
    handleAnalysisError(error?.message || "Analysis failed.");
  } finally {
    state.scanInFlight = false;
    if (state.pendingScan) {
      state.pendingScan = false;
      scheduleScan(300);
    }
  }
}

function handleAnalysisError(message) {
  if (message === "MISSING_API_KEY") {
    showBanner("Add an API key in the Reality Check popup to analyze this page.");
    return;
  }

  showBanner(`Reality Check could not analyze this page: ${message}`);
}

function collectSegments() {
  const selector = Array.from(BLOCK_TAGS).map((tag) => tag.toLowerCase()).join(", ");
  const elements = Array.from(document.body?.querySelectorAll(selector) || []);
  const segments = [];
  const seenHashes = new Set();

  for (const element of elements) {
    if (segments.length >= MAX_CANDIDATES_PER_SCAN) {
      break;
    }

    if (!isEligibleElement(element)) {
      continue;
    }

    const text = normalizeText(element.innerText || element.textContent || "");
    if (text.length < MIN_TEXT_LENGTH || text.length > MAX_TEXT_LENGTH) {
      continue;
    }

    if (isContainerElement(element, text)) {
      continue;
    }

    const hash = hashText(text);
    if (state.analyzedHashes.has(hash) || seenHashes.has(hash)) {
      continue;
    }

    const priority = scoreSegment(text);
    if (priority < 1) {
      continue;
    }

    seenHashes.add(hash);
    segments.push({
      id: `segment-${hash}`,
      text,
      html: shrinkHtml(element.outerHTML || "", 1800),
      priority,
      element,
      hash
    });
  }

  segments.sort((left, right) => right.priority - left.priority || left.text.length - right.text.length);
  return segments.slice(0, MAX_SEGMENTS_PER_SCAN);
}

function isEligibleElement(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.closest(`[${EXTENSION_ROOT_ATTRIBUTE}="true"]`)) {
    return false;
  }

  if (element.hasAttribute(FLAG_ATTRIBUTE)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    parseFloat(style.opacity || "1") < 0.05
  ) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isContainerElement(element, text) {
  if (!["DIV", "SECTION", "ARTICLE", "MAIN", "ASIDE"].includes(element.tagName)) {
    return false;
  }

  const substantialChildren = Array.from(element.children).filter((child) => {
    if (!BLOCK_TAGS.has(child.tagName)) {
      return false;
    }

    const childText = normalizeText(child.innerText || child.textContent || "");
    return childText.length >= MIN_TEXT_LENGTH / 2;
  });

  if (substantialChildren.length >= 3) {
    return true;
  }

  return text.length > 1000 && substantialChildren.length >= 1;
}

function scoreSegment(text) {
  let score = 0;

  for (const pattern of HIGH_PRIORITY_PATTERNS) {
    if (pattern.test(text)) {
      score += 2;
    }
  }

  if (/\b(she|her|woman|women|female)\b/i.test(text) && /\b(leader|president|minister|ceo|senator|mayor|governor)\b/i.test(text)) {
    score += 3;
  }

  if (/\b(disinformation|rumor|hoax|fake|lie|lying|fraud|propaganda)\b/i.test(text)) {
    score += 2;
  }

  return score;
}

function applyAnalysisResults(results, segments) {
  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const flaggedIds = new Set();

  for (const result of results) {
    const segment = segmentById.get(result.id);
    if (!segment || !result.flagged) {
      continue;
    }

    flaggedIds.add(result.id);
    state.analyzedHashes.add(segment.hash);
    state.analysisById.set(result.id, result);
    highlightSegment(segment, result);
  }

  for (const segment of segments) {
    state.analyzedHashes.add(segment.hash);
    if (!flaggedIds.has(segment.id)) {
      segment.element.setAttribute(HASH_ATTRIBUTE, segment.hash);
    }
  }
}

function highlightSegment(segment, analysis) {
  const element = segment.element;
  if (!(element instanceof HTMLElement)) {
    return;
  }

  element.classList.add("reality-check-flagged");
  element.setAttribute(FLAG_ATTRIBUTE, "true");
  element.setAttribute(ID_ATTRIBUTE, analysis.id);
  element.setAttribute(HASH_ATTRIBUTE, segment.hash);
  element.setAttribute(
    "data-reality-check-label",
    `${severityLabel(analysis.severity)} ${analysis.category.replace(/_/g, " ")}`
  );

  const existingChip = element.querySelector(":scope > .reality-check-chip");
  if (!existingChip && isChipFriendly(element)) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "reality-check-chip";
    chip.setAttribute(EXTENSION_ROOT_ATTRIBUTE, "true");
    chip.textContent = "Reality Check";
    chip.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDetailPanel(analysis, element);
    });
    element.prepend(chip);
  }
}

function isChipFriendly(element) {
  const display = window.getComputedStyle(element).display;
  return display !== "inline" && display !== "contents";
}

function openDetailPanel(analysis, element) {
  closeDetailPanel();

  const panel = document.createElement("aside");
  panel.className = "reality-check-panel";
  panel.setAttribute(EXTENSION_ROOT_ATTRIBUTE, "true");
  panel.innerHTML = `
    <div class="reality-check-panel__header">
      <div>
        <p class="reality-check-eyebrow">Reality Check</p>
        <h2>${escapeHtml(headlineFor(analysis))}</h2>
      </div>
      <button type="button" class="reality-check-close" aria-label="Close">Close</button>
    </div>
    <p class="reality-check-summary">${escapeHtml(analysis.summary || "This section may contain targeted hate speech or disinformation.")}</p>
    <dl class="reality-check-grid">
      <div>
        <dt>Category</dt>
        <dd>${escapeHtml((analysis.category || "unknown").replace(/_/g, " "))}</dd>
      </div>
      <div>
        <dt>Confidence</dt>
        <dd>${formatConfidence(analysis.confidence)}</dd>
      </div>
      <div>
        <dt>Target</dt>
        <dd>${escapeHtml(analysis.target || "Woman leader or public figure")}</dd>
      </div>
      <div>
        <dt>Severity</dt>
        <dd>${escapeHtml(severityLabel(analysis.severity))}</dd>
      </div>
    </dl>
    <div class="reality-check-copy">
      <h3>Why it was flagged</h3>
      <p>${escapeHtml(analysis.evidence || "The language appears to use gendered hostility or manipulative framing.")}</p>
    </div>
    <div class="reality-check-copy">
      <h3>What to watch for</h3>
      <p>${escapeHtml(analysis.guidance || "Check whether the claim relies on stereotypes, unsupported allegations, or demeaning language.")}</p>
    </div>
  `;

  const closeButton = panel.querySelector(".reality-check-close");
  closeButton?.addEventListener("click", () => closeDetailPanel());

  document.body.appendChild(panel);
  element.scrollIntoView({ block: "center", behavior: "smooth" });
}

function closeDetailPanel() {
  const panel = document.querySelector(".reality-check-panel");
  if (panel) {
    panel.remove();
  }
}

function clearHighlights() {
  const elements = document.querySelectorAll(`[${FLAG_ATTRIBUTE}="true"]`);
  elements.forEach((element) => {
    element.classList.remove("reality-check-flagged");
    element.removeAttribute(FLAG_ATTRIBUTE);
    element.removeAttribute(ID_ATTRIBUTE);
    element.removeAttribute(HASH_ATTRIBUTE);
    element.removeAttribute("data-reality-check-label");
    const chip = element.querySelector(":scope > .reality-check-chip");
    chip?.remove();
  });

  state.analysisById.clear();
  state.analyzedHashes.clear();
}

function showBanner(message) {
  const key = String(message || "");
  if (state.bannerKey === key) {
    return;
  }

  clearBanner();
  state.bannerKey = key;

  const banner = document.createElement("div");
  banner.className = "reality-check-banner";
  banner.setAttribute(EXTENSION_ROOT_ATTRIBUTE, "true");
  banner.textContent = key;

  const dismissButton = document.createElement("button");
  dismissButton.type = "button";
  dismissButton.className = "reality-check-banner__dismiss";
  dismissButton.setAttribute(EXTENSION_ROOT_ATTRIBUTE, "true");
  dismissButton.textContent = "Dismiss";
  dismissButton.addEventListener("click", () => clearBanner());

  banner.appendChild(dismissButton);
  document.body.appendChild(banner);
}

function clearBanner() {
  state.bannerKey = null;
  document.querySelector(".reality-check-banner")?.remove();
}

function headlineFor(analysis) {
  if (analysis.category === "both") {
    return "Potential hate speech and disinformation";
  }

  if (analysis.category === "gendered_disinformation") {
    return "Potential gendered disinformation";
  }

  return "Potential targeted hate speech";
}

function severityLabel(severity) {
  switch (severity) {
    case "high":
      return "High";
    case "medium":
      return "Medium";
    default:
      return "Low";
  }
}

function formatConfidence(confidence) {
  const safeConfidence = Number.isFinite(Number(confidence)) ? Number(confidence) : 0;
  return `${Math.round(safeConfidence * 100)}%`;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function shrinkHtml(value, maxLength) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function hashText(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash).toString(36);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function injectStyles() {
  if (document.getElementById("reality-check-style-root")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "reality-check-style-root";
  style.textContent = `
    .reality-check-flagged {
      cursor: pointer !important;
      position: relative !important;
      border-radius: 10px !important;
      box-shadow: inset 0 0 0 2px rgba(163, 29, 29, 0.55), 0 0 0 3px rgba(252, 233, 233, 0.95) !important;
      background: linear-gradient(180deg, rgba(255, 243, 243, 0.8), rgba(255, 233, 233, 0.95)) !important;
      transition: box-shadow 160ms ease, transform 160ms ease !important;
    }

    .reality-check-flagged:hover {
      box-shadow: inset 0 0 0 2px rgba(163, 29, 29, 0.75), 0 8px 24px rgba(74, 21, 28, 0.14) !important;
      transform: translateY(-1px) !important;
    }

    .reality-check-flagged::before {
      content: attr(data-reality-check-label);
      position: absolute;
      top: -11px;
      left: 10px;
      z-index: 2147483645;
      padding: 3px 9px;
      border-radius: 999px;
      background: #7a1d1d;
      color: #fff9f0;
      font: 600 11px/1.2 Arial, sans-serif;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      pointer-events: none;
    }

    .reality-check-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin: 0 0 10px;
      padding: 5px 10px;
      border: 0;
      border-radius: 999px;
      background: #7a1d1d;
      color: #fff9f0;
      font: 600 12px/1 Arial, sans-serif;
      cursor: pointer;
    }

    .reality-check-panel {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 2147483646;
      width: min(420px, calc(100vw - 24px));
      max-height: min(80vh, 640px);
      overflow: auto;
      border-radius: 18px;
      padding: 18px;
      background: #fffaf7;
      color: #211818;
      box-shadow: 0 24px 80px rgba(35, 20, 23, 0.24);
      font-family: Arial, sans-serif;
    }

    .reality-check-panel__header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
    }

    .reality-check-eyebrow {
      margin: 0 0 6px;
      color: #8c3a2f;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    .reality-check-panel h2,
    .reality-check-panel h3,
    .reality-check-panel p,
    .reality-check-panel dd,
    .reality-check-panel dt {
      margin: 0;
    }

    .reality-check-panel h2 {
      font-size: 22px;
      line-height: 1.1;
      margin-bottom: 12px;
    }

    .reality-check-summary {
      margin-bottom: 16px !important;
      line-height: 1.5;
      color: #4a3535;
    }

    .reality-check-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 16px;
      padding: 14px;
      border-radius: 12px;
      background: #f6ece6;
    }

    .reality-check-grid dt {
      color: #744746;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 4px !important;
    }

    .reality-check-grid dd {
      color: #211818;
      line-height: 1.4;
    }

    .reality-check-copy {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid #ecd9d3;
    }

    .reality-check-copy h3 {
      margin-bottom: 6px !important;
      font-size: 14px;
    }

    .reality-check-copy p {
      line-height: 1.5;
      color: #4a3535;
    }

    .reality-check-close,
    .reality-check-banner__dismiss {
      border: 0;
      border-radius: 999px;
      padding: 8px 12px;
      background: #211818;
      color: #fffaf7;
      cursor: pointer;
      font: 600 12px/1 Arial, sans-serif;
    }

    .reality-check-banner {
      position: fixed;
      left: 20px;
      bottom: 20px;
      z-index: 2147483647;
      max-width: min(420px, calc(100vw - 24px));
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 14px;
      background: #211818;
      color: #fffaf7;
      box-shadow: 0 18px 45px rgba(35, 20, 23, 0.24);
      font: 500 13px/1.45 Arial, sans-serif;
    }

    @media (max-width: 640px) {
      .reality-check-panel {
        left: 12px;
        right: 12px;
        bottom: 12px;
        width: auto;
      }

      .reality-check-grid {
        grid-template-columns: 1fr;
      }

      .reality-check-banner {
        left: 12px;
        right: 12px;
        bottom: 12px;
        max-width: none;
      }
    }
  `;

  document.documentElement.appendChild(style);
}

async function getStoredValue(key, fallbackValue) {
  const result = await chrome.storage.local.get([key]);
  return result[key] === undefined ? fallbackValue : result[key];
}
