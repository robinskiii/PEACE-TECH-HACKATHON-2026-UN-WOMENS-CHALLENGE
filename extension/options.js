const $ = (s) => document.querySelector(s);
const TEXT_FIELDS = ["sharedKey", "teamKey", "aiBaseUrl", "model", "serverUrl"];
const sendBg = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (res) => r(res || { ok: false, error: chrome.runtime.lastError?.message })));

function say(id, text, ok) { const m = $(id); m.textContent = text; m.className = "msg " + (ok ? "ok" : "err"); }

async function load() {
  const s = await kalasagSettings();
  $("#country").value = s.country;
  document.querySelectorAll("#languages input").forEach((c) => (c.checked = s.languages.includes(c.value)));
  for (const name of ["role", "display", "scope"]) {
    const r = document.querySelector(`input[name=${name}][value="${s[name]}"]`);
    if (r) r.checked = true;
  }
  $("#blurForTarget").checked = s.blurForTarget;
  TEXT_FIELDS.forEach((f) => ($("#" + f).value = s[f]));
  $("#maxItemsPerPage").value = s.maxItemsPerPage;
  $("#excludedSites").value = s.excludedSites.join("\n");
}

function read() {
  const langs = [...document.querySelectorAll("#languages input:checked")].map((c) => c.value);
  const out = {
    country: $("#country").value,
    languages: langs.length ? langs : ["en"],
    role: document.querySelector("input[name=role]:checked")?.value || "ally",
    display: document.querySelector("input[name=display]:checked")?.value || "full",
    scope: document.querySelector("input[name=scope]:checked")?.value || "smart",
    blurForTarget: $("#blurForTarget").checked,
    maxItemsPerPage: Math.max(10, Math.min(1000, Number($("#maxItemsPerPage").value) || 150)),
    excludedSites: $("#excludedSites").value.split("\n").map((x) => x.trim()).filter(Boolean),
    setupDone: true,
  };
  TEXT_FIELDS.forEach((f) => (out[f] = $("#" + f).value.trim()));
  if (!out.aiBaseUrl) out.aiBaseUrl = KALASAG_DEFAULTS.aiBaseUrl;
  if (!out.model) out.model = KALASAG_DEFAULTS.model;
  if (!out.serverUrl) out.serverUrl = KALASAG_DEFAULTS.serverUrl;
  return out;
}

async function save() {
  const current = await kalasagSettings();
  await chrome.storage.local.set({ settings: { ...current, ...read() } });
}

$("#form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await save();
  say("#saveMsg", "Saved. Open pages update automatically.", true);
});

$("#testAI").addEventListener("click", async (e) => {
  e.target.disabled = true;
  await save();
  say("#aiMsg", "Testing…", true);
  const r = await sendBg({ type: "testAI" });
  say("#aiMsg", r.ok ? `Connected with the ${r.keyUsed} key. The model replied: "${r.reply}"` : r.error, r.ok);
  e.target.disabled = false;
});

$("#testServer").addEventListener("click", async (e) => {
  e.target.disabled = true;
  await save();
  const r = await sendBg({ type: "refreshLexicon" });
  say("#serverMsg", r.ok ? `Connected. ${r.count} words downloaded.` : `Can't reach the website (${r.error}). Is app.py running?`, r.ok);
  e.target.disabled = false;
});

load();
