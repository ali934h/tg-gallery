/**
 * Centralised configuration loader.
 * Reads environment variables, validates required ones, exposes a frozen
 * config object. Throws clear errors if required vars are missing.
 */

require("dotenv").config();
const path = require("path");

function num(name, defaultValue, { min, max } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: '${raw}' is not a number`);
  }
  if (min !== undefined && parsed < min) {
    throw new Error(`${name} must be >= ${min}, got ${parsed}`);
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`${name} must be <= ${max}, got ${parsed}`);
  }
  return parsed;
}

function csvIntSet(name) {
  const raw = process.env[name] || "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const n = Number(s);
        if (!Number.isFinite(n)) {
          throw new Error(`Invalid ID in ${name}: '${s}'`);
        }
        return n;
      })
  );
}

function require_(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function bool(name, defaultValue) {
  const raw = (process.env[name] || "").trim().toLowerCase();
  if (raw === "") return defaultValue;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`Invalid ${name}: '${raw}' (expected true/false)`);
}

function bigInt(name) {
  const raw = (process.env[name] || "").trim();
  if (raw === "") return null;
  // Accept negative integers (Telegram channel IDs are negative bigints).
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`Invalid ${name}: '${raw}' (expected an integer)`);
  }
  return raw;
}

const NODE_ENV = process.env.NODE_ENV || "development";
const isProduction = NODE_ENV === "production";

const config = Object.freeze({
  nodeEnv: NODE_ENV,
  isProduction,

  botToken: require_("BOT_TOKEN"),

  // In production we also need a public webhook domain.
  webhookDomain: isProduction
    ? require_("WEBHOOK_DOMAIN").replace(/\/$/, "")
    : (process.env.WEBHOOK_DOMAIN || "").replace(/\/$/, ""),
  webhookPath: process.env.WEBHOOK_PATH || "/webhook",

  // Random secret that Telegram sends in the X-Telegram-Bot-Api-Secret-Token
  // header on every webhook delivery. Required in production.
  webhookSecret: isProduction
    ? require_("WEBHOOK_SECRET")
    : process.env.WEBHOOK_SECRET || "",

  port: num("PORT", 3000, { min: 1, max: 65535 }),

  downloadsDir:
    process.env.DOWNLOADS_DIR || path.join(process.cwd(), "downloads"),
  tempDir: process.env.TEMP_DIR || path.join(process.cwd(), "temp"),

  // The URL prefix the bot returns to users. nginx serves the directory.
  downloadBaseUrl:
    (process.env.DOWNLOAD_BASE_URL || "http://localhost:3000/downloads").replace(
      /\/$/,
      ""
    ),

  allowedUsers: csvIntSet("ALLOWED_USERS"),

  downloadConcurrency: num("DOWNLOAD_CONCURRENCY", 5, { min: 1, max: 20 }),
  downloadTimeoutMs: num("DOWNLOAD_TIMEOUT_MS", 60000, { min: 5000 }),
  downloadRetries: num("DOWNLOAD_RETRIES", 3, { min: 1, max: 10 }),

  scrapeTimeoutMs: num("SCRAPE_TIMEOUT_MS", 30000, { min: 5000 }),
  scrapeRetries: num("SCRAPE_RETRIES", 3, { min: 1, max: 10 }),
  fallbackStrategyLimit: num("FALLBACK_STRATEGY_LIMIT", 5, { min: 1, max: 50 }),
  fallbackMinImages: num("FALLBACK_MIN_IMAGES", 5, { min: 1 }),

  // Optional SOCKS5 proxy for strategies that have useProxy=true.
  proxyUrl: process.env.PROXY_URL || "",

  // Sessions
  sessionIdleTtlMs: num(
    "SESSION_IDLE_TTL_MS",
    24 * 60 * 60 * 1000,
    { min: 60_000 }
  ),
  sessionCleanupIntervalMs: num(
    "SESSION_CLEANUP_INTERVAL_MS",
    60 * 60 * 1000,
    { min: 60_000 }
  ),

  tempCleanupIntervalMs: num(
    "TEMP_CLEANUP_INTERVAL_MS",
    60 * 60 * 1000,
    { min: 60_000 }
  ),
  tempMaxAgeMs: num("TEMP_MAX_AGE_MS", 60 * 60 * 1000, { min: 60_000 }),

  logLevel: process.env.LOG_LEVEL || "info",

  // Optional userbot upload — when enabled, every successfully built ZIP
  // is also sent to a private Telegram channel via GramJS.
  telegramUpload: (() => {
    const enabled = bool("TELEGRAM_UPLOAD_ENABLED", false);
    if (!enabled) {
      return { enabled: false };
    }
    // A bad value in any of these env vars (e.g. TG_API_ID=abc) must NOT
    // crash the process — channel upload is optional and the link-only
    // flow has to keep working. Catch parse errors and fall back to
    // disabled with a clear warning.
    try {
      const apiId = num("TG_API_ID");
      const apiHash = process.env.TG_API_HASH || "";
      const session = process.env.TG_SESSION || "";
      const channelId = bigInt("UPLOAD_CHANNEL_ID");
      const maxBytes = num("TELEGRAM_UPLOAD_MAX_BYTES", 2 * 1024 * 1024 * 1024, {
        min: 1024 * 1024,
      });
      const missing = [];
      if (!Number.isFinite(apiId) || apiId <= 0) missing.push("TG_API_ID");
      if (!apiHash) missing.push("TG_API_HASH");
      if (!channelId) missing.push("UPLOAD_CHANNEL_ID");
      if (!session) missing.push("TG_SESSION (run `node setup.js`)");
      if (missing.length) {
        // Don't crash — keep the bot running with upload disabled so users
        // can fix the .env later without losing the link-only flow.
        // eslint-disable-next-line no-console
        console.warn(
          `[config] TELEGRAM_UPLOAD_ENABLED=true but missing: ${missing.join(", ")}. ` +
            `Channel upload disabled until these are filled in.`
        );
        return { enabled: false };
      }
      return {
        enabled: true,
        apiId,
        apiHash,
        session,
        channelId,
        maxBytes,
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[config] TELEGRAM_UPLOAD_ENABLED=true but a value is malformed: ${err.message}. ` +
          `Channel upload disabled until the .env is corrected.`
      );
      return { enabled: false };
    }
  })(),
});

module.exports = config;
