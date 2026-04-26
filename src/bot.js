/**
 * Bot wiring: registers middleware + handlers on the GramJS-based BotAdapter,
 * then attaches the adapter to a connected TelegramClient.
 */

const { BotAdapter } = require("./tg/adapter");
const config = require("./config");
const logger = require("./logger");
const sessions = require("./sessions");
const strategyEngine = require("./scrapers/strategyEngine");
const commands = require("./handlers/commands");
const filesHandler = require("./handlers/files");
const job = require("./handlers/job");

function isAllowed(userId) {
  if (config.allowedUsers.size === 0) return true;
  return config.allowedUsers.has(userId);
}

function build(client) {
  const bot = new BotAdapter(client);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (!isAllowed(userId)) {
      logger.warn(`Unauthorized access attempt by user: ${userId}`);
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery("⛔ Access denied.");
      } else {
        await ctx.reply("⛔ You are not authorized to use this bot.").catch(() => {});
      }
      return;
    }
    return next();
  });

  commands.register(bot);
  filesHandler.register(bot);
  job.register(bot);

  bot.catch(async (err, ctx) => {
    logger.error("Unhandled bot error", {
      error: err.message,
      user: ctx.from?.id,
    });
    try {
      await ctx.reply(
        "An unexpected error occurred. Please try again or send /start to reset."
      );
    } catch (_e) {
      // ignore
    }
    if (ctx.from?.id) sessions.reset(ctx.from.id);
  });

  return bot;
}

async function setBotCommands(bot) {
  try {
    await bot.setMyCommands([
      { command: "start", description: "Start the bot" },
      { command: "help", description: "How to use this bot" },
      { command: "files", description: "View and manage downloaded files" },
      { command: "cancel", description: "Cancel current operation" },
    ]);
    logger.info("Bot commands menu set successfully");
  } catch (err) {
    logger.warn("Failed to set bot commands", { error: err.message });
  }
}

async function initialize(bot) {
  await strategyEngine.load();
  await setBotCommands(bot);
  sessions.startCleanup();
  bot.attach();
  if (config.allowedUsers.size > 0) {
    logger.info(`Whitelist active: ${[...config.allowedUsers].join(", ")}`);
  } else {
    logger.warn("No ALLOWED_USERS set — bot is open to ALL Telegram users");
  }
  logger.info("Bot event handlers attached");
}

module.exports = { build, initialize };
