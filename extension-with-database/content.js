// =====================================================================
// Reality Check: content script (runs inside web pages)
//  1. finds posts on the page
//  2. checks them against the approved word list from our database
//     (locally: page text never leaves the computer for this)
//  3. adds a badge; clicking it explains why, what to do, and the law
//  4. optional AI check for posts about a watched name with no known word
// =====================================================================

(() => {
  if (window.__realityCheckLoaded) return;
  window.__realityCheckLoaded = true;

  const POST_SELECTORS = [
    "[data-testid='tweetText']",   // X / Twitter
    "[data-ad-preview='message']", // Facebook
    "[data-ad-preview='true']",
    "article",                     // news sites
    ".post-content",               // our test page
    "[class*='post-content']"
  ].join(",");

  const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };
  const COLORS = { urgent: "#7a0012", high: "#d32f2f", medium: "#ef6c00", low: "#f9a825", ai: "#6a1b9a", ok: "#2e7d32" };

  let state = { settings: null, lexicon: null, popupInfo: null, patterns: [] };

  // ---------- helpers ----------
  const norm = (s) => (s || "").normalize("NFKC").toLowerCase();
  const isWordChar = (ch) => /[\p{L}\p{N}_]/u.test(ch || "");
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
  }

  function safeLink(url, label) {
    if (!url || !/^https?:\/\//i.test(url)) return document.createTextNode(label);
    return el("a", { href: url, target: "_blank", rel: "noopener noreferrer", text: label });
  }

  function extensionAlive() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  // ---------- build the matcher from the lexicon ----------
  function buildPatterns(lexicon) {
    const patterns = [];
    for (const entry of lexicon?.entries || []) {
      for (const raw of [entry.term, ...(entry.variants || [])]) {
        const text = norm(raw).trim();
        if (text.length < 2) continue;
        // Whole-word match for normal words ("witch" must not match "switch");
        // plain "contains" for hashtags, emoji and phrases with symbols
        const wordy = isWordChar(text[0]) && isWordChar(text[text.length - 1]);
        // (also allows a plural ending, so "presstitute" catches "presstitutes")
        const regex = wordy
          ? new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(text)}(?:s|es)?(?=$|[^\\p{L}\\p{N}_])`, "u")
          : null;
        patterns.push({ text, regex, entry, shown: raw });
      }
    }
    // Longer phrases first, so "slept her way to the top" wins over shorter hits
    return patterns.sort((a, b) => b.text.length - a.text.length);
  }

  function findMatches(text) {
    const t = norm(text);
    const byEntry = new Map();
    for (const p of state.patterns) {
      const hit = p.regex ? p.regex.test(t) : t.includes(p.text);
      if (hit && !byEntry.has(p.entry.id)) byEntry.set(p.entry.id, { entry: p.entry, matched: p.shown });
    }
    return [...byEntry.values()].sort((a, b) =>
      (b.entry.is_urgent - a.entry.is_urgent) ||
      (SEVERITY_RANK[b.entry.severity] - SEVERITY_RANK[a.entry.severity]));
  }

  function mentionsWatchedName(text) {
    const t = norm(text);
    return (RC_CONFIG.WATCHED_NAMES || []).some((n) => t.includes(norm(n)));
  }

  // ---------- scanning ----------
  function candidatePosts() {
    const all = [...document.querySelectorAll(POST_SELECTORS)];
    // keep the innermost match only (e.g. a post inside an <article>)
    return all.filter((node) => !all.some((other) => other !== node && node.contains(other)));
  }

  function textKey(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return String(h);
  }

  // Post text without our own badge
  function postText(post) {
    const copy = post.cloneNode(true);
    copy.querySelectorAll(".rc-badge").forEach((b) => b.remove());
    return (copy.innerText || copy.textContent || "").replace(/\s+/g, " ").trim();
  }

  async function processPage() {
    if (!state.settings?.enabled || !state.patterns) return;
    for (const post of candidatePosts()) {
      const text = postText(post);
      if (text.length < 8) continue;
      const key = textKey(text);
      if (post.dataset.rcKey === key) continue; // already checked this exact text
      post.dataset.rcKey = key;
      post.querySelectorAll(":scope > .rc-badge").forEach((b) => b.remove());
      post.classList.remove("rc-flagged");

      const matches = findMatches(text);
      if (matches.length) {
        addBadge(post, { kind: "lexicon", matches, text });
      } else if (mentionsWatchedName(text) && extensionAlive()) {
        runAiCheck(post, text);
      }
    }
  }

  async function runAiCheck(post, text) {
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type: "ai-check", text });
    } catch { return; }
    if (!result || result.skipped || result.error) {
      if (result?.error) console.warn("[Reality Check] AI check failed:", result.error);
      return;
    }
    addBadge(post, { kind: "ai", ai: result, text });
  }

  // ---------- badge ----------
  function badgeLook(finding) {
    if (finding.kind === "lexicon") {
      const top = finding.matches[0].entry;
      if (top.is_urgent) return { color: COLORS.urgent, label: "!", title: "Urgent: possible threat" };
      return { color: COLORS[top.severity] || COLORS.medium, label: "⚠", title: `${top.category_name}: ${top.subtype_name || ""}` };
    }
    const ai = finding.ai;
    if (ai.category === "none") return { color: COLORS.ok, label: "✓", title: "No gendered attack detected (AI check)" };
    if (ai.is_urgent) return { color: COLORS.urgent, label: "!", title: "Urgent: possible threat (AI check)" };
    return { color: COLORS.ai, label: "AI", title: "Possible gendered attack (AI check)" };
  }

  function addBadge(post, finding) {
    const look = badgeLook(finding);
    if (getComputedStyle(post).position === "static") post.style.position = "relative";
    if (!(finding.kind === "ai" && finding.ai.category === "none")) post.classList.add("rc-flagged");
    post.style.setProperty("--rc-color", look.color);
    const badge = el("button", {
      class: "rc-badge", title: look.title, "aria-label": `Reality Check: ${look.title}`,
      text: look.label,
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); showCard(finding); }
    });
    badge.style.background = look.color;
    post.append(badge);
  }

  // ---------- explanation card ----------
  function stepsFor(categoryCode, isUrgent) {
    const steps = state.popupInfo?.next_steps || {};
    if (state.settings.role === "ally") return steps["all:ally"] || [];
    if (isUrgent) return steps["urgent:any"] || [];
    return steps[`${categoryCode}:any`] || [];
  }

  function platformInfo() {
    const host = location.hostname.replace(/^www\./, "");
    const key = /(^|\.)x\.com$|twitter\.com$/.test(host) ? "x"
      : /facebook\.com$/.test(host) ? "facebook"
      : /instagram\.com$/.test(host) ? "instagram"
      : /tiktok\.com$/.test(host) ? "tiktok" : null;
    return (state.popupInfo?.platforms || []).find((p) => p.platform === key) || null;
  }

  function section(title, children) {
    return el("div", { class: "rc-section" }, [el("div", { class: "rc-section-title", text: title }), ...children]);
  }

  function showCard(finding) {
    document.querySelector(".rc-card")?.remove();
    const look = badgeLook(finding);
    const parts = [];
    let categoryCode, isUrgent, headline, sub;

    if (finding.kind === "lexicon") {
      const top = finding.matches[0].entry;
      categoryCode = top.category;
      isUrgent = top.is_urgent;
      headline = top.category_name;
      sub = top.subtype_name;
      parts.push(section("Why it was flagged", finding.matches.slice(0, 3).map(({ entry, matched }) =>
        el("div", { class: "rc-match" }, [
          el("span", { class: "rc-term", text: `“${matched}”` }),
          el("span", { class: "rc-lang", text: ` ${entry.language}${entry.country ? " · " + entry.country : ""}` }),
          el("div", { text: entry.meaning || "" }),
          entry.context_note ? el("div", { class: "rc-note", text: entry.context_note }) : null
        ]))));
      if (categoryCode === "gendered_disinformation") {
        parts.push(el("div", { class: "rc-verify", text: "Verification needed. This tool never rules on whether a claim is true." }));
      }
    } else {
      const ai = finding.ai;
      categoryCode = ai.category;
      isUrgent = !!ai.is_urgent;
      headline = { gender_hate_speech: "Gender Hate Speech", gendered_disinformation: "Gendered Disinformation",
                   manipulated_text: "Gendered Manipulated Text / Context", none: "Legitimate Criticism / None" }[ai.category] || ai.category;
      sub = ai.subtype ? ai.subtype.replace(/_/g, " ") : null;
      parts.push(section("AI explanation", [
        el("div", { text: ai.explanation || "" }),
        el("div", { class: "rc-note", text: "AI check: it can be wrong. No word from our community list matched this post." })
      ]));
      if (ai.verification_needed) parts.push(el("div", { class: "rc-verify", text: "Verification needed." }));
    }

    if (categoryCode !== "none") {
      const steps = stepsFor(categoryCode, isUrgent);
      if (steps.length) {
        const who = state.settings.role === "ally" ? "What to do next (you are an ally)" : "What to do next";
        parts.push(section(who, [el("ol", {}, steps.map((s) => el("li", { text: s })))]));
      }
      const legal = state.popupInfo?.legal;
      if (legal) {
        parts.push(section(`The law in ${state.popupInfo.country}`, [
          el("div", {}, [el("strong", {}, [safeLink(legal.law_url, legal.law_name)])]),
          el("div", { text: legal.what_it_covers }),
          el("div", {}, ["Report to: ", safeLink(legal.report_url, legal.where_to_report)]),
          legal.helpline ? el("div", { text: `Helpline: ${legal.helpline}` }) : null,
          el("div", { class: "rc-disclaimer", text: legal.disclaimer })
        ]));
      }
      const platform = platformInfo();
      if (platform) {
        parts.push(section(`Report on ${platform.display_name}`, [
          el("div", { text: platform.how_to_report }),
          safeLink(platform.report_url, platform.link_label || "Reporting guide")
        ]));
      }
    }

    const status = el("div", { class: "rc-status" });
    const saveBtn = el("button", { class: "rc-btn rc-btn-primary", text: "Save as evidence" });
    saveBtn.addEventListener("click", () => saveEvidence(finding, card, saveBtn, status));

    const card = el("div", { class: "rc-card", role: "dialog", "aria-label": "Reality Check explanation" }, [
      el("div", { class: "rc-card-head" }, [
        el("div", { class: "rc-dot" }),
        el("div", {}, [
          el("div", { class: "rc-headline", text: headline }),
          sub ? el("div", { class: "rc-sub", text: sub }) : null
        ]),
        isUrgent ? el("span", { class: "rc-urgent", text: "URGENT" }) : null,
        el("button", { class: "rc-close", "aria-label": "Close", text: "×", onclick: () => card.remove() })
      ]),
      el("div", { class: "rc-body" }, parts),
      el("div", { class: "rc-actions" }, [
        categoryCode !== "none" ? saveBtn : null,
        el("button", { class: "rc-btn", text: "Close", onclick: () => card.remove() })
      ]),
      status
    ]);
    card.style.setProperty("--rc-color", look.color);
    document.body.append(card);
  }

  async function saveEvidence(finding, card, btn, status) {
    if (!extensionAlive()) { status.textContent = "Extension was reloaded. Refresh the page."; return; }
    btn.disabled = true;
    status.textContent = "Capturing screenshot…";
    card.style.visibility = "hidden";            // keep the card out of the screenshot
    await new Promise((r) => setTimeout(r, 150));
    const top = finding.kind === "lexicon" ? finding.matches[0] : null;
    const report = {
      platform: platformInfo()?.platform || "other",
      flagged_text: finding.text.slice(0, 500),   // only the flagged post, never the whole page
      matched_entry_id: top?.entry.id || null,
      matched_text: top?.matched || null,
      category_code: top ? top.entry.category : finding.ai.category,
      subtype_code: top ? top.entry.subtype : finding.ai.subtype || null,
      is_urgent: top ? top.entry.is_urgent : !!finding.ai.is_urgent,
      language_code: top?.entry.language || null,
      classification: finding.kind === "ai" ? finding.ai : null
    };
    let res;
    try { res = await chrome.runtime.sendMessage({ type: "save-evidence", report }); }
    catch (e) { res = { error: e.message }; }
    card.style.visibility = "visible";
    if (res?.error) {
      status.textContent = `Could not save: ${res.error}`;
      btn.disabled = false;
    } else {
      const where = res.saved === "backend" ? "Sent to the Reality Check database." : "Saved on this computer. It will be sent once our server is connected.";
      status.textContent = `✓ ${where} Fingerprint (SHA-256): ${res.sha256.slice(0, 16)}…`;
      btn.textContent = "Saved";
    }
  }

  // ---------- start ----------
  async function loadState() {
    const data = await chrome.storage.local.get(["settings", "lexicon", "popupInfo"]);
    state.settings = { ...RC_CONFIG.DEFAULT_SETTINGS, ...(data.settings || {}) };
    state.lexicon = data.lexicon || null;
    state.popupInfo = data.popupInfo || null;
    state.patterns = buildPatterns(state.lexicon);
  }

  function resetPage() {
    document.querySelectorAll(".rc-badge, .rc-card").forEach((n) => n.remove());
    document.querySelectorAll("[data-rc-key]").forEach((n) => { delete n.dataset.rcKey; n.classList.remove("rc-flagged"); });
  }

  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(processPage, 400); };

  chrome.storage.onChanged.addListener(async (changes) => {
    if (changes.settings || changes.lexicon || changes.popupInfo) {
      await loadState();
      resetPage();
      schedule();
    }
  });

  (async () => {
    await loadState();
    if (!state.lexicon && extensionAlive()) {
      // first run: ask the background to download the word list
      try { await chrome.runtime.sendMessage({ type: "refresh" }); } catch {}
      await loadState();
    }
    processPage();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
  })();
})();
