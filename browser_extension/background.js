const STORAGE_DEFAULTS = {
  enabled: true,
  apiEndpoint: "https://inference-rcp.epfl.ch/v1/chat/completions",
  model: "deepseek-ai/DeepSeek-V4-Flash-0731",
  apiKey: ""
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "REALITY_CHECK_ANALYZE") {
    return false;
  }

  void handleAnalysisRequest(message.payload)
    .then((response) => sendResponse(response))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message || "Unknown analysis error."
      });
    });

  return true;
});

async function handleAnalysisRequest(payload) {
  const settings = await chrome.storage.local.get(Object.keys(STORAGE_DEFAULTS));
  const enabled = settings.enabled ?? STORAGE_DEFAULTS.enabled;
  const apiKey = (settings.apiKey ?? STORAGE_DEFAULTS.apiKey).trim();
  const apiEndpoint = normalizeEndpoint(settings.apiEndpoint ?? STORAGE_DEFAULTS.apiEndpoint);
  const model = (settings.model ?? STORAGE_DEFAULTS.model).trim();

  if (!enabled) {
    return { ok: true, results: [] };
  }

  if (!apiKey) {
    return { ok: false, error: "MISSING_API_KEY" };
  }

  const segments = Array.isArray(payload?.segments) ? payload.segments.slice(0, 18) : [];
  if (!segments.length) {
    return { ok: true, results: [] };
  }

  const results = [];
  const batches = chunk(segments, 6);

  for (const batch of batches) {
    const batchResults = await analyzeBatch({
      batch,
      page: payload?.page,
      apiKey,
      apiEndpoint,
      model
    });
    results.push(...batchResults);
  }

  return { ok: true, results };
}

async function analyzeBatch({ batch, page, apiKey, apiEndpoint, model }) {
  const systemPrompt = [
    "You are a safety analyst focused on hate speech and disinformation aimed at women leaders or women in visible positions of authority.",
    "Review each text segment together with its HTML snippet for context.",
    "Flag a segment only if it plausibly contains one of the following:",
    "1. gender-targeted hate speech aimed at a woman leader or public-facing female authority figure,",
    "2. gendered disinformation that uses stereotypes, fabricated claims, misleading rumors, or manipulative framing against a woman leader,",
    "3. both of the above.",
    "Do not flag ordinary policy disagreement, neutral reporting, or criticism that is not gender-targeted or misleading.",
    "When uncertain, do not flag.",
    "Return only valid JSON in this exact structure:",
    '{"results":[{"id":"segment-id","flagged":true,"category":"hate_speech|gendered_disinformation|both","confidence":0.0,"target":"targeted person or role","summary":"one sentence summary","evidence":"one or two sentences explaining the concerning language or claim","guidance":"one sentence telling the reader what to watch for","severity":"low|medium|high"}]}'
  ].join("\n");

  const userPrompt = JSON.stringify(
    {
      page,
      segments: batch.map((segment) => ({
        id: segment.id,
        text: segment.text,
        html: segment.html
      }))
    },
    null,
    2
  );

  const response = await fetch(apiEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 900,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await safeReadError(response);
    throw new Error(errorText || `API request failed with status ${response.status}.`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  const parsed = parseModelJson(content);
  const results = Array.isArray(parsed?.results) ? parsed.results : [];

  return results
    .filter((result) => result?.id && result?.flagged)
    .map((result) => ({
      id: String(result.id),
      flagged: true,
      category: sanitizeCategory(result.category),
      confidence: sanitizeConfidence(result.confidence),
      target: String(result.target || "Woman leader or public figure"),
      summary: String(result.summary || "Potential targeted hate speech or disinformation."),
      evidence: String(result.evidence || "The wording appears to rely on a gendered attack or misleading framing."),
      guidance: String(result.guidance || "Look for stereotypes, demeaning cues, or unsupported claims."),
      severity: sanitizeSeverity(result.severity)
    }));
}

function normalizeEndpoint(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return STORAGE_DEFAULTS.apiEndpoint;
  }

  if (/\/chat\/completions\/?$/i.test(trimmed)) {
    return trimmed;
  }

  if (/\/v1\/?$/i.test(trimmed)) {
    return `${trimmed.replace(/\/$/, "")}/chat/completions`;
  }

  return `${trimmed.replace(/\/$/, "")}/chat/completions`;
}

function parseModelJson(content) {
  if (!content) {
    throw new Error("The model returned an empty response.");
  }

  const cleaned = String(content)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("The model response was not valid JSON.");
    }

    return JSON.parse(match[0]);
  }
}

function sanitizeCategory(value) {
  const category = String(value || "").trim().toLowerCase();
  if (category === "hate_speech" || category === "gendered_disinformation" || category === "both") {
    return category;
  }
  return "gendered_disinformation";
}

function sanitizeSeverity(value) {
  const severity = String(value || "").trim().toLowerCase();
  if (severity === "high" || severity === "medium" || severity === "low") {
    return severity;
  }
  return "medium";
}

function sanitizeConfidence(value) {
  const confidence = Number(value);
  if (Number.isFinite(confidence)) {
    return Math.max(0, Math.min(1, confidence));
  }
  return 0.5;
}

async function safeReadError(response) {
  try {
    const data = await response.json();
    return data?.error?.message || JSON.stringify(data);
  } catch (error) {
    return response.statusText;
  }
}

function chunk(list, size) {
  const output = [];
  for (let index = 0; index < list.length; index += size) {
    output.push(list.slice(index, index + size));
  }
  return output;
}
