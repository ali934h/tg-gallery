/**
 * Application entry point.
 *
 * Connects to Telegram via MTProto using the bot token (so the bot can
 * upload files up to 2 GB, well beyond the 50 MB Bot-API HTTP limit), starts
 * the bot's event handlers, and runs the small Express server that serves
 * the /health endpoint behind nginx (which itself serves /downloads/).
 */

const fs = require("fs");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const config = require("./config");
const logger = require("./logger");
const fileManager = require("./fileManager");
const sessions = require("./sessions");
const botModule = require("./bot");
const server = require("./server");

async function loadOrCreateSession() {
  if (fs.existsSync(config.sessionFile)) {
    const saved = fs.readFileSync(config.sessionFile, "utf8").trim();
    if (saved) return saved;
  }
  return "";
}

async function persistSession(client, prevSession) {
  try {
    const next = client.session.save();
    if (next && next !== prevSession) {
      fs.writeFileSync(config.sessionFile, next, { mode: 0o600 });
      logger.info("Telegram session saved");
    }
  } catch (err) {
    logger.warn("Could not persist session", { error: err.message });
  }
}

async function main() {
  await fileManager.ensureDir(config.downloadsDir);
  await fileManager.ensureDir(config.tempDir);

  const savedSession = await loadOrCreateSession();
  const client = new TelegramClient(
    new StringSession(savedSession),
    config.apiId,
    config.apiHash,
    {
      connectionRetries: 10,
      autoReconnect: true,
    }
  );
  client.setLogLevel(config.logLevel === "debug" ? "info" : "error");

  logger.info("Connecting to Telegram via MTProto...");
  await client.start({
    botAuthToken: config.botToken,
  });
  await persistSession(client, savedSession);

  const me = await client.getMe();
  logger.info(
    `Logged in as @${me.username || me.firstName || "bot"} (id=${me.id})`
  );

  const bot = botModule.build(client);
  await botModule.initialize(bot);

  const app = server.build();
  await server.listen(app);

  setInterval(
    () => fileManager.cleanupOldTempDirs(config.tempDir, config.tempMaxAgeMs),
    config.tempCleanupIntervalMs
  ).unref?.();

  logger.info(
    `tg-gallery is running (env=${config.nodeEnv}, downloadsDir=${config.downloadsDir})`
  );

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down gracefully`);
    sessions.stopCleanup();
    try {
      await client.disconnect();
    } catch (_e) {
      // ignore
    }
    process.exit(0);
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { error: err.message, stack: err.stack });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { reason: String(reason) });
});

main().catch((err) => {
  logger.error("Failed to start tg-gallery", {
    error: err.message,
    stack: err.stack,
  });
  process.exit(1);
});
