const $ = (s) => document.querySelector(s);
let tab = null;

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
const sendBg = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (res) => r(res || { ok: false, error: chrome.runtime.lastError?.message })));
const sendTab = (msg) => new Promise((r) => chrome.tabs.sendMessage(tab.id, msg, (res) => r(chrome.runtime.lastError ? null : res)));

function isLocalPage(url) {
  try {
    const page = new URL(url);
    return page.protocol === "file:" || page.hostname === "localhost" ||
      page.hostname === "127.0.0.1" || page.hostname === "[::1]" || page.hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

async function stateForTab() {
  let state = tab ? await sendTab({ type: "tab:state" }) : null;
  if (state || !tab || !isLocalPage(tab.url)) return state;

  // A declared content script only starts on a page navigation. Attach it here
  // when a local page was already open as the extension was reloaded.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id }, files: ["shared.js", "content.js"],
    });
    state = await sendTab({ type: "tab:state" });
  } catch (e) {
    console.warn("Couldn't attach Kalasag to this local page:", e.message);
  }
  return state;
}

async function saveSettings(patch) {
  const s = await kalasagSettings();
  await chrome.storage.local.set({ settings: { ...s, ...patch } });
}

const STATUS_TEXT = {
  starting: "Reading the page…", checking: "Checking…", done: "Checked", "ai-error": "AI check failed",
  limit: "Stopped at the per-page limit", off: "Kalasag is off", paused: "Paused on this site",
};

async function render() {
  const s = await kalasagSettings();
  $("#enabled").checked = s.enabled;
  const page = $("#page");
  page.replaceChildren();
  const st = await stateForTab();

  if (!st) {
    const localHint = tab?.url?.startsWith("file:")
      ? " Enable ‘Allow access to file URLs’ on Kalasag’s chrome://extensions details page."
      : tab && isLocalPage(tab.url)
      ? " Reload Kalasag from chrome://extensions, then open this popup again."
      : " It works on normal websites, not browser pages or the Web Store. If you just installed or reloaded the extension, refresh the page.";
    page.append(el("p", "muted", "Kalasag can't read this page." + localHint));
    $("#rescan").disabled = true; $("#pause").disabled = true;
  } else {
    const flagsLine = el("p");
    flagsLine.append(el("span", "big", String(st.flags)), el("span", "muted", st.flags === 1 ? "  flagged item" : "  flagged items"));
    page.append(flagsLine, el("p", "muted", `${STATUS_TEXT[st.status] || st.status} · ${st.checked} snippets checked by AI` +
      (st.waiting ? ` · ${st.waiting} waiting` : "")));
    if (st.lastError) page.append(el("p", "err", st.lastError));
    const paused = kalasagIsExcluded(st.host, s.excludedSites);
    $("#pause").textContent = paused ? "Resume on this site" : "Pause on this site";
    $("#pause").onclick = async () => {
      const list = paused ? s.excludedSites.filter((x) => !kalasagIsExcluded(st.host, [x])) : [...s.excludedSites, st.host];
      await saveSettings({ excludedSites: list });
      setTimeout(render, 300);
    };
  }

  const ai = $("#ai");
  ai.replaceChildren();
  const { aiStatus, lexicon = [], pending = [] } = await chrome.storage.local.get(["aiStatus", "lexicon", "pending"]);
  if (!s.sharedKey && !s.teamKey) ai.append(el("p", "err", "No AI key set, so only the word list is used. Add a key in Settings."));
  else if (aiStatus && aiStatus.ok) ai.append(el("p", "ok", `AI connected (${aiStatus.keyUsed} key)`));
  else if (aiStatus && !aiStatus.ok) ai.append(el("p", "err", `AI problem: ${aiStatus.error}`));
  ai.append(el("p", "muted", `${lexicon.length} words in the word list`));

  const pb = $("#pending");
  pb.hidden = !pending.length;
  pb.textContent = `Send ${pending.length} saved report${pending.length === 1 ? "" : "s"} to the website`;
}

$("#enabled").addEventListener("change", async (e) => { await saveSettings({ enabled: e.target.checked }); setTimeout(render, 300); });
$("#rescan").addEventListener("click", async () => { await sendTab({ type: "tab:rescan" }); setTimeout(render, 500); });
$("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("#words").addEventListener("click", async (e) => {
  e.target.disabled = true; e.target.textContent = "Refreshing…";
  const r = await sendBg({ type: "refreshLexicon" });
  e.target.textContent = r.ok ? `Word list updated (${r.count} words)` : "Website not reachable. Is app.py running?";
  e.target.disabled = false;
  render();
});
$("#pending").addEventListener("click", async (e) => {
  e.target.disabled = true;
  const r = await sendBg({ type: "retryPending" });
  e.target.disabled = false;
  e.target.textContent = r.ok ? `Sent ${r.sent}, ${r.left} still waiting` : r.error;
  setTimeout(render, 1500);
});

chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => { tab = t; render(); });
