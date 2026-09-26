// Reality Check: popup settings

const $ = (id) => document.getElementById(id);

function timeAgo(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

async function render() {
  const { settings, lexiconStatus, evidence = [] } =
    await chrome.storage.local.get(["settings", "lexiconStatus", "evidence"]);
  const s = { ...RC_CONFIG.DEFAULT_SETTINGS, ...(settings || {}) };

  $("enabled").checked = s.enabled;
  $("country").value = s.country;
  $("role").value = s.role;
  document.querySelectorAll("#languages input").forEach((box) => { box.checked = s.languages.includes(box.value); });

  const box = $("status");
  box.classList.toggle("error", lexiconStatus && lexiconStatus.ok === false);
  if (!lexiconStatus) {
    box.textContent = "Word list not downloaded yet.";
  } else if (lexiconStatus.ok === false) {
    box.textContent = `Could not update the word list (${lexiconStatus.error}). Using the last saved copy.`;
  } else {
    box.textContent = `${lexiconStatus.count} words for ${lexiconStatus.country} (${lexiconStatus.languages.join(", ")}), updated ${timeAgo(lexiconStatus.fetchedAt)}.`;
  }
  if (evidence.length) {
    box.textContent += ` ${evidence.length} evidence item(s) saved on this computer.`;
  }
}

async function save() {
  const languages = [...document.querySelectorAll("#languages input:checked")].map((b) => b.value);
  const settings = {
    enabled: $("enabled").checked,
    country: $("country").value,
    role: $("role").value,
    languages: languages.length ? languages : ["en"]
  };
  await chrome.storage.local.set({ settings });
}

document.addEventListener("DOMContentLoaded", () => {
  render();
  ["enabled", "country", "role"].forEach((id) => $(id).addEventListener("change", save));
  document.querySelectorAll("#languages input").forEach((b) => b.addEventListener("change", save));
  $("refresh").addEventListener("click", async () => {
    $("refresh").disabled = true;
    $("status").textContent = "Updating…";
    await chrome.runtime.sendMessage({ type: "refresh" });
    $("refresh").disabled = false;
    render();
  });
  chrome.storage.onChanged.addListener(render);
});
