// =====================================================================
// Reality Check: settings shared by every part of the extension
// =====================================================================

const RC_CONFIG = {
  // Our Supabase project. The publishable key is SAFE to ship in the
  // extension: the database only lets it read approved words + public info.
  SUPABASE_URL: "https://ghjomcqfzvhmamloypjz.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_H2vCPbobSKcVPpr3z_UqJQ_-8suJO8v",

  // Our FastAPI backend. Leave "" until it is running.
  // When set, "Save as evidence" goes to  POST {BACKEND_URL}/reports
  // and the AI check goes to            POST {BACKEND_URL}/check-context
  BACKEND_URL: "",

  // AI check for posts that mention a watched name but contain no known word
  // (e.g. fabricated quotes). TEMPORARY DEMO SHORTCUT: calling the AI straight
  // from the extension means the key is inside the extension, and anyone who
  // installs it can read it. Use a throwaway key with a low spending limit, and
  // switch to BACKEND_URL as soon as the backend exists.
  AI: {
    enabled: false,
    endpoint: "https://api.deepseek.com/v1/chat/completions", // any OpenAI-compatible endpoint
    model: "deepseek-chat",
    apiKey: ""
  },

  // Public names the AI check watches for. (The private "leaders" table in the
  // database is never sent to the extension, on purpose.)
  WATCHED_NAMES: ["Minister Reyes", "Maria Reyes", "Asha Verma", "Dr. Verma", "Maria Ressa"],

  DEFAULT_SETTINGS: {
    enabled: true,
    country: "PH",
    languages: ["en", "tl"],
    role: "ally" // target | ally | organization
  },

  REFRESH_MINUTES: 360
};
