const DEFAULTS = {
  enabled: true,
  apiEndpoint: "https://inference-rcp.epfl.ch/v1/chat/completions",
  model: "deepseek-ai/DeepSeek-V4-Flash-0731",
  apiKey: ""
};

document.addEventListener("DOMContentLoaded", async () => {
  const enabledInput = document.getElementById("enableExtension");
  const apiKeyInput = document.getElementById("apiKey");
  const endpointInput = document.getElementById("apiEndpoint");
  const modelInput = document.getElementById("model");
  const saveButton = document.getElementById("saveSettings");
  const rescanButton = document.getElementById("rescanPage");
  const status = document.getElementById("status");

  const settings = await chrome.storage.local.get(Object.keys(DEFAULTS));
  enabledInput.checked = settings.enabled ?? DEFAULTS.enabled;
  apiKeyInput.value = settings.apiKey ?? DEFAULTS.apiKey;
  endpointInput.value = settings.apiEndpoint ?? DEFAULTS.apiEndpoint;
  modelInput.value = settings.model ?? DEFAULTS.model;

  enabledInput.addEventListener("change", async () => {
    await chrome.storage.local.set({ enabled: enabledInput.checked });
    if (!enabledInput.checked) {
      await sendActiveTabMessage({ type: "REALITY_CHECK_CLEAR" });
    } else {
      await sendActiveTabMessage({ type: "REALITY_CHECK_RESCAN" });
    }
    showStatus(status, enabledInput.checked ? "Protection enabled." : "Protection paused.");
  });

  saveButton.addEventListener("click", async () => {
    await chrome.storage.local.set({
      apiKey: apiKeyInput.value.trim(),
      apiEndpoint: endpointInput.value.trim() || DEFAULTS.apiEndpoint,
      model: modelInput.value.trim() || DEFAULTS.model
    });

    await sendActiveTabMessage({ type: "REALITY_CHECK_RESCAN" });
    showStatus(status, "Settings saved. The current page will be rescanned.");
  });

  rescanButton.addEventListener("click", async () => {
    const response = await sendActiveTabMessage({ type: "REALITY_CHECK_RESCAN" });
    showStatus(status, response?.ok ? "Rescan requested." : "Open a page and try again.");
  });
});

async function sendActiveTabMessage(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return { ok: false };
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    return { ok: false, error: error?.message };
  }
}

function showStatus(element, message) {
  element.textContent = message;
  element.hidden = false;
  window.clearTimeout(showStatus.timeoutId);
  showStatus.timeoutId = window.setTimeout(() => {
    element.hidden = true;
  }, 2500);
}
