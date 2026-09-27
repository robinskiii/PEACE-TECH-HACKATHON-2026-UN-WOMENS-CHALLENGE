// Content script: runs on every page. It reads the text, asks the background worker
// to check it, and draws highlights and the pop-up on top of the page.
// It never edits the page's own elements, so it doesn't break sites like Facebook.
(() => {
  if (window.__kalasagLoaded) return;
  window.__kalasagLoaded = true;

  const SKIP = "script,style,noscript,template,textarea,input,select,option,code,pre,svg,canvas,iframe,button," +
               "[contenteditable=''],[contenteditable='true'],[aria-hidden='true']";
  const BATCH_SIZE = 12, CONCURRENCY = 2, MIN_LEN = 20, MAX_LEN = 1200;

  const state = {
    settings: null, matchers: [], flags: [], seen: new WeakMap(), cache: new Map(), dismissed: new Set(),
    queue: [], inFlight: 0, sent: 0, checked: 0, status: "starting", lastError: null, active: false, url: location.href,
  };
  let nextId = 1;
  const displayCache = new WeakMap();

  // ------------------------------------------------ messaging helpers
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: "No answer from the extension." });
        });
      } catch (e) {
        resolve({ ok: false, error: "The extension was reloaded. Refresh this page." });
      }
    });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  // ------------------------------------------------ reading the page
  function displayOf(el) {
    let d = displayCache.get(el);
    if (!d) { d = getComputedStyle(el).display; displayCache.set(el, d); }
    return d;
  }

  // The nearest ancestor that is laid out as a block: a paragraph, a post body, a comment.
  function blockFor(textNode) {
    let el = textNode.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      const d = displayOf(el);
      if (d !== "inline" && d !== "contents") return el;
      el = el.parentElement;
    }
    return null;
  }

  function textOf(el) {
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function collectBlocks() {
    if (!document.body) return [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue.trim().length > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const blocks = new Set();
    const skipCache = new WeakMap();
    let node, visited = 0;
    while ((node = walker.nextNode()) && visited < 30000) {
      visited++;
      const parent = node.parentElement;
      if (!parent) continue;
      let skip = skipCache.get(parent);
      if (skip === undefined) { skip = !!parent.closest(SKIP); skipCache.set(parent, skip); }
      if (skip) continue;
      const block = blockFor(node);
      if (block) blocks.add(block);
    }
    // Drop wrapper blocks that contain other blocks, so each piece of text is checked once.
    const hasInnerBlock = new Set();
    for (const b of blocks) {
      let p = b.parentElement;
      while (p) { if (blocks.has(p)) hasInnerBlock.add(p); p = p.parentElement; }
    }
    return [...blocks].filter((b) => !hasInnerBlock.has(b));
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  }

  // ------------------------------------------------ scanning
  async function loadSettings() {
    const [settings, { lexicon = [] }] = await Promise.all([kalasagSettings(), chrome.storage.local.get("lexicon")]);
    state.settings = settings;
    state.matchers = kalasagBuildMatchers(lexicon);
    state.aiOff = !(settings.sharedKey || "").trim() && !(settings.teamKey || "").trim();
    // Pages can opt out with <meta name="kalasag" content="skip">, e.g. the Kalasag dashboard itself,
    // which shows the harmful words on purpose.
    const optedOut = !!document.querySelector('meta[name="kalasag"][content="skip"]');
    state.active = settings.enabled && !optedOut && !kalasagIsExcluded(location.hostname, settings.excludedSites);
    state.status = !settings.enabled ? "off" : !state.active ? "paused" : state.status;
  }

  function scan() {
    if (!state.active) return;
    if (location.href !== state.url) {           // single-page apps change URL without reloading
      state.url = location.href;
      state.sent = 0;
    }
    const s = state.settings;
    let queued = 0;
    for (const el of collectBlocks()) {
      const text = textOf(el);
      if (text.length < MIN_LEN) continue;
      const clipped = text.slice(0, MAX_LEN);
      const hash = kalasagHash(clipped);
      if (state.seen.get(el) === hash) continue;
      state.seen.set(el, hash);
      if (state.dismissed.has(hash) || !isVisible(el)) continue;

      if (state.cache.has(hash)) {                 // same text seen before on this page: reuse the answer
        const cached = state.cache.get(hash);
        if (cached) addFlag({ el, text: clipped, hash, hints: cached.hints }, cached.info);
        continue;
      }
      const hints = kalasagFindHints(clipped, state.matchers);
      const relevant = hints.length || s.scope === "all" || kalasagLooksRelevant(clipped);
      if (!relevant) continue;
      if (state.aiOff) {                           // no key: word-list matches only
        if (hints.length) addFlag({ el, text: clipped, hash, hints }, wordListOnly(hints, "No AI key is set"));
        continue;
      }
      if (state.sent >= s.maxItemsPerPage) { state.status = "limit"; break; }
      state.sent++;
      queued++;
      state.queue.push({ id: nextId++, el, text: clipped, hash, hints });
    }
    if (queued) state.status = "checking";
    pump();
  }

  function wordListOnly(hints, why) {
    const h = hints[0];
    return {
      category: h.category, severity: h.severity, quote: h.matched, target: "",
      reason: `Matches "${h.term}" from the verified word list. ${why}, so the context wasn't checked.`,
      unconfirmed: true,
    };
  }

  function pump() {
    while (state.inFlight < CONCURRENCY && state.queue.length) {
      const batch = state.queue.splice(0, BATCH_SIZE);
      state.inFlight++;
      runBatch(batch).finally(() => {
        state.inFlight--;
        if (!state.queue.length && !state.inFlight && state.status === "checking") state.status = "done";
        pump();
      });
    }
  }

  async function runBatch(batch) {
    const res = await send({
      type: "classify",
      page: { title: document.title.slice(0, 160), url: location.href },
      items: batch.map((b) => ({ id: b.id, text: b.text, hints: b.hints })),
    });
    if (!res.ok) {
      state.lastError = res.error;
      state.status = "ai-error";
      for (const b of batch) if (b.hints.length) addFlag(b, wordListOnly(b.hints, "The AI check failed"));
      return;
    }
    state.lastError = null;
    state.checked += batch.length;
    const byId = new Map(batch.map((b) => [b.id, b]));
    const flaggedIds = new Set();
    for (const f of res.flagged) {
      const b = byId.get(Number(f.id));
      if (!b || flaggedIds.has(b.id)) continue;
      flaggedIds.add(b.id);
      const info = { category: f.category, severity: f.severity, target: f.target, quote: f.quote, reason: f.reason };
      state.cache.set(b.hash, { info, hints: b.hints });
      addFlag(b, info);
    }
    for (const b of batch) if (!flaggedIds.has(b.id)) state.cache.set(b.hash, null);
  }

  // ------------------------------------------------ overlay (drawn in a shadow root on top of the page)
  const host = document.createElement("kalasag-layer");
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>
    :host { all: initial; }
    .root { font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1F2A48; }
    .box { position: fixed; border: 2px solid var(--c); border-radius: 5px; background: var(--bg); pointer-events: none; box-sizing: border-box; }
    .box.high { --c: #C0392B; --bg: rgba(192,57,43,.08); }
    .box.medium { --c: #E4A11B; --bg: rgba(228,161,27,.10); }
    .box.low { --c: #7E8BB0; --bg: rgba(126,139,176,.10); }
    .box.unconfirmed { border-style: dashed; }
    .tag { position: absolute; top: -13px; right: 6px; pointer-events: auto; cursor: pointer; border: 0;
      background: var(--c); color: #fff; font: 700 12px/1 system-ui, sans-serif; padding: 5px 9px; border-radius: 12px;
      box-shadow: 0 2px 6px rgba(20,26,43,.25); }
    .box.medium .tag { color: #1F2A48; }
    .tag:focus-visible, button:focus-visible { outline: 3px solid #1F2A48; outline-offset: 2px; }
    .veil { position: absolute; inset: 0; pointer-events: auto; border-radius: 3px; display: flex; align-items: center;
      justify-content: center; gap: 8px; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      background: rgba(31,42,72,.30); }
    .veil button { font: 600 13px system-ui, sans-serif; border: 0; border-radius: 6px; padding: 6px 12px; cursor: pointer;
      background: #fff; color: #1F2A48; }
    .panel { position: fixed; right: 16px; top: 16px; width: min(380px, calc(100vw - 32px)); max-height: calc(100vh - 32px);
      overflow: auto; background: #fff; border-radius: 12px; box-shadow: 0 16px 48px rgba(20,26,43,.30);
      pointer-events: auto; padding: 18px 18px 16px; box-sizing: border-box; }
    .panel[hidden], .capturing .panel, .capturing .veil { display: none; }
    .stripe { height: 5px; border-radius: 3px; margin: -4px 0 14px;
      background: repeating-linear-gradient(90deg, #E4A11B 0 10px, transparent 10px 14px, #1F2A48 14px 20px, transparent 20px 24px); }
    .head { display: flex; justify-content: space-between; gap: 10px; align-items: start; }
    h2 { font-size: 17px; margin: 0; line-height: 1.3; }
    h3 { font-size: 13px; margin: 16px 0 4px; }
    p { margin: 0 0 8px; }
    .x { border: 0; background: none; font-size: 22px; line-height: 1; cursor: pointer; color: #4A5572; padding: 0 2px; }
    .chips { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0 10px; }
    .chip { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 10px; background: #EEF0F5; }
    .chip.high { background: #F8E4E1; color: #A33A2F; } .chip.medium { background: #FDF3DC; }
    blockquote { margin: 0 0 10px; padding: 4px 0 4px 10px; border-left: 3px solid #E4A11B; color: #4A5572; }
    .muted { color: #4A5572; font-size: 13px; }
    .tip { background: #EEF4F3; border-radius: 8px; padding: 10px 12px; font-size: 13px; margin: 12px 0 0; }
    ol { margin: 0; padding-left: 20px; } li { margin-bottom: 3px; }
    a { color: #17665E; }
    .law { margin-bottom: 6px; } .law strong { display: block; font-size: 13px; }
    .actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
    .btn { font: 600 14px system-ui, sans-serif; border-radius: 7px; padding: 8px 14px; cursor: pointer; border: 1px solid #1F2A48; }
    .btn.primary { background: #1F2A48; color: #fff; } .btn.secondary { background: #fff; color: #1F2A48; border-color: #D8DCE4; }
    .btn:disabled { opacity: .55; cursor: wait; }
    .status { font-size: 13px; margin-top: 10px; } .status.ok { color: #17665E; } .status.err { color: #A33A2F; }
    .hash { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #4A5572; word-break: break-all; }
    @media (prefers-color-scheme: dark) {
      .root { color: #E8EBF3; } .panel { background: #1C2438; } .x, .muted, blockquote, .hash { color: #A7AFC4; }
      .chip { background: #2A3350; } .chip.high { background: #3B1F1C; color: #EC8B80; } .chip.medium { background: #3A2F16; }
      .tip { background: #153230; } a { color: #5DC0B3; }
      .btn { border-color: #E8EBF3; } .btn.primary { background: #E8EBF3; color: #1C2438; }
      .btn.secondary { background: transparent; color: #E8EBF3; border-color: #2E3850; }
    }
  </style><div class="root"><div class="boxes"></div><aside class="panel" hidden role="dialog" aria-label="Kalasag"></aside></div>`;
  const root = shadow.querySelector(".root");
  const boxesEl = shadow.querySelector(".boxes");
  const panel = shadow.querySelector(".panel");
  let openFlag = null;

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }

  function mountOverlay() {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }

  function addFlag(item, info) {
    if (state.dismissed.has(item.hash) || state.flags.some((f) => f.el === item.el)) return;
    const severity = ["low", "medium", "high"].includes(info.severity) ? info.severity : "medium";
    const category = KALASAG_CATEGORIES[info.category] ? info.category : "unclassified";
    const flag = {
      el: item.el, text: item.text, hash: item.hash, hints: item.hints || [], category, severity,
      target: String(info.target || "").slice(0, 120), quote: String(info.quote || "").slice(0, 300),
      reason: String(info.reason || "").slice(0, 400), unconfirmed: !!info.unconfirmed, revealed: false,
    };
    flag.box = h("div", { class: `box ${severity}${flag.unconfirmed ? " unconfirmed" : ""}` });
    flag.tag = h("button", { class: "tag", type: "button", onclick: () => openPanel(flag),
      "aria-label": `Kalasag: ${KALASAG_CATEGORIES[category]}. Open details.` }, "Kalasag");
    flag.box.append(flag.tag);
    state.flags.push(flag);
    mountOverlay();
    boxesEl.append(flag.box);
    applyVeil(flag);
    position();
    send({ type: "badge", count: state.flags.length });
  }

  function applyVeil(flag) {
    const want = state.settings.role === "target" && state.settings.blurForTarget && !flag.revealed;
    if (want && !flag.veil) {
      flag.veil = h("div", { class: "veil" },
        h("button", { type: "button", onclick: () => openPanel(flag) }, "Why is this hidden?"),
        h("button", { type: "button", onclick: () => { flag.revealed = true; applyVeil(flag); } }, "Show"));
      flag.box.prepend(flag.veil);
    } else if (!want && flag.veil) {
      flag.veil.remove();
      flag.veil = null;
    }
  }

  function removeFlag(flag) {
    flag.box.remove();
    state.flags = state.flags.filter((f) => f !== flag);
    if (openFlag === flag) closePanel();
    send({ type: "badge", count: state.flags.length });
  }

  let raf = 0;
  function position() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      for (const f of [...state.flags]) {
        if (!f.el.isConnected) { removeFlag(f); continue; }  // feeds remove posts as you scroll
        const r = f.el.getBoundingClientRect();
        const hidden = r.width === 0 || r.bottom < -50 || r.top > innerHeight + 50;
        f.box.style.display = hidden ? "none" : "block";
        if (hidden) continue;
        f.box.style.left = `${r.left - 4}px`;
        f.box.style.top = `${r.top - 4}px`;
        f.box.style.width = `${r.width + 8}px`;
        f.box.style.height = `${r.height + 8}px`;
      }
    });
  }
  addEventListener("scroll", position, { capture: true, passive: true });
  addEventListener("resize", position, { passive: true });
  setInterval(position, 1000);

  // ------------------------------------------------ pop-up
  const ROLE_TIPS = {
    target: "This looks aimed at you. You don't have to read the thread. Saving it as evidence lets your support team see it for you.",
    ally: "Replying or sharing, even to disagree, shows it to more people. Reporting it and saving evidence helps more.",
    organization: "Save this as evidence so it's counted in the leader's alert, then follow up with the platform.",
  };

  async function openPanel(flag) {
    openFlag = flag;
    const s = state.settings;
    const hint = flag.hints[0];
    const status = h("p", { class: "status", role: "status" });
    const saveBtn = h("button", { class: "btn primary", type: "button", onclick: () => saveEvidence(flag, saveBtn, status) }, "Save as evidence");

    panel.replaceChildren(
      h("div", { class: "stripe" }),
      h("div", { class: "head" },
        h("h2", {}, KALASAG_CATEGORIES[flag.category]),
        h("button", { class: "x", type: "button", "aria-label": "Close", onclick: closePanel }, "×")),
      h("div", { class: "chips" },
        h("span", { class: `chip ${flag.severity}` }, `${flag.severity} severity`),
        flag.target ? h("span", { class: "chip" }, `Aimed at: ${flag.target}`) : null,
        h("span", { class: "chip" }, flag.unconfirmed ? "Word list only" : hint ? "AI and word list" : "AI")),
      h("h3", {}, "Why it was flagged"),
      flag.reason ? h("p", {}, flag.reason) : null,
      flag.quote && !(s.role === "target" && !flag.revealed) ? h("blockquote", {}, flag.quote) : null,
      hint ? h("p", { class: "muted" }, `Word list: "${hint.term}". ${hint.meaning || ""}`) : null,
      flag.unconfirmed ? h("p", { class: "muted" }, "Check this one yourself: the word can also be used harmlessly.") : null,
      h("p", { class: "tip" }, ROLE_TIPS[s.role] || ROLE_TIPS.ally),
      s.display === "full" ? h("div", { class: "legal" }, h("p", { class: "muted" }, "Loading what the law says…")) : null,
      h("div", { class: "actions" }, saveBtn,
        h("button", { class: "btn secondary", type: "button", onclick: () => { state.dismissed.add(flag.hash); removeFlag(flag); } },
          "Not harmful")),
      status,
    );
    panel.hidden = false;
    panel.querySelector(".x").focus();

    if (s.display === "full") {
      const res = await send({ type: "legalInfo", country: s.country, platform: kalasagPlatformOf(location.hostname) });
      const box = panel.querySelector(".legal");
      if (!box || openFlag !== flag) return;
      if (!res.ok) { box.replaceChildren(h("p", { class: "muted" }, "Legal information isn't available right now.")); return; }
      const info = res.info;
      box.replaceChildren(...[                   // filter: replaceChildren would print "null" for empty parts
        h("h3", {}, `What the law says (${info.country})`),
        ...(info.laws || []).map((l) => h("div", { class: "law" }, h("strong", {}, l.name), h("span", { class: "muted" }, l.summary))),
        h("h3", {}, "How to report it"),
        h("ol", {}, ...(info.report_steps || []).map((step) => h("li", {}, step))),
        (info.authorities || []).length ? h("p", { class: "muted", style: "margin-top:8px" }, "Authorities: ",
          ...info.authorities.flatMap((a, i) => [i ? ", " : "", h("a", { href: a.url, target: "_blank", rel: "noopener" }, a.name)])) : null,
        flag.category === "threat" && info.threat_note ? h("p", { class: "tip" }, info.threat_note) : null,
      ].filter(Boolean));
    }
  }

  function closePanel() {
    panel.hidden = true;
    const f = openFlag;
    openFlag = null;
    if (f && f.tag.isConnected) f.tag.focus();
  }
  addEventListener("keydown", (e) => { if (e.key === "Escape" && openFlag) closePanel(); });

  async function saveEvidence(flag, btn, status) {
    const s = state.settings;
    btn.disabled = true;
    status.className = "status";
    status.textContent = "Taking a screenshot…";
    flag.el.scrollIntoView({ block: "center", behavior: "instant" });
    root.classList.add("capturing");              // hide the pop-up and blur so the screenshot shows the content
    position();
    await frame();
    await sleep(150);
    const hint = flag.hints[0];
    const res = await send({ type: "saveEvidence", report: {
      lexicon_id: hint ? hint.id : null,
      matched_text: flag.quote || (hint && hint.matched) || flag.text.slice(0, 200),
      context_text: flag.text,
      category: flag.category,
      url: location.href,
      platform: kalasagPlatformOf(location.hostname),
      reporter_role: s.role,
      country: s.country,
    } });
    root.classList.remove("capturing");
    btn.disabled = false;
    if (res.ok && res.saved) {
      status.className = "status ok";
      status.replaceChildren("Saved as evidence.", h("br"),
        res.report.screenshot_sha256 ? h("span", { class: "hash" }, `Fingerprint ${res.report.screenshot_sha256.slice(0, 24)}…`) : "");
      btn.textContent = "Saved";
      btn.disabled = true;
    } else if (res.ok && res.queued) {
      status.className = "status err";
      status.textContent = "The Kalasag website isn't reachable, so this was kept on your computer. Send it later from the toolbar button.";
    } else {
      status.className = "status err";
      status.textContent = res.error || "Couldn't save.";
    }
  }

  // ------------------------------------------------ status for the toolbar pop-up
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg.type === "tab:state") {
      reply({ status: state.status, active: state.active, flags: state.flags.length, checked: state.checked,
              waiting: state.queue.length + state.inFlight * BATCH_SIZE, lastError: state.lastError,
              aiOff: state.aiOff, host: location.hostname });
    } else if (msg.type === "tab:rescan") {
      rescan().then(() => reply({ ok: true }));
      return true;
    }
    return false;
  });

  async function rescan() {
    for (const f of [...state.flags]) removeFlag(f);
    state.seen = new WeakMap();
    state.cache.clear();
    state.queue = [];
    state.sent = 0;
    state.checked = 0;
    state.lastError = null;
    await loadSettings();
    state.status = state.active ? "starting" : state.status;
    scan();
  }

  chrome.storage.onChanged.addListener(async (changes) => {
    if (changes.lexicon) { await rescan(); return; }
    if (changes.settings) {
      const before = state.settings;
      await loadSettings();
      if (!state.active) { for (const f of [...state.flags]) removeFlag(f); return; }
      const important = ["enabled", "excludedSites", "scope", "sharedKey", "teamKey", "model", "aiBaseUrl"]
        .some((k) => String(before && before[k]) !== String(state.settings[k]));
      if (important) { await rescan(); return; }
      state.flags.forEach(applyVeil);
      if (openFlag) openPanel(openFlag);
    }
  });

  // ------------------------------------------------ start
  let debounce = 0;
  const observer = new MutationObserver((mutations) => {
    if (mutations.every((m) => m.target === host || host.contains(m.target))) return;
    clearTimeout(debounce);
    debounce = setTimeout(scan, 1200);             // wait for feeds to finish loading new posts
  });

  (async () => {
    await loadSettings();
    if (document.readyState === "loading") await new Promise((r) => addEventListener("DOMContentLoaded", r, { once: true }));
    await sleep(800);                               // let the page render first
    scan();
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  })();
})();
