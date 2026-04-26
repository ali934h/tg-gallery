/**
 * /start, /help, /cancel, /files commands and the main text handler that
 * accepts gallery URLs and prompts for an archive name.
 */

const { Markup } = require("../tg/markup");
const sessions = require("../sessions");
const archiveName = require("../archiveName");
const strategyEngine = require("../scrapers/strategyEngine");
const jsdomScraper = require("../scrapers/jsdomScraper");
const filesHandler = require("./files");

function pendingJobKeyboard(renameLabel = "✏️ Rename") {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Start Download", "start_download")],
    [Markup.button.callback(renameLabel, "rename_archive")],
    [Markup.button.callback("❌ Cancel", "cancel_pending_job")],
  ]);
}

function buildJobSummary(session) {
  if (!session.pendingJob) return "Session expired. Please send the URLs again.";
  const { urls, archiveName: name } = session.pendingJob;
  return (
    `📋 ${urls.length} gallery URL${urls.length === 1 ? "" : "s"} detected\n\n` +
    `📁 Archive name: ${name}\n\n` +
    `Tap "Start Download" to begin, "Rename" to choose a custom name, ` +
    `or "Cancel" to reset.\n\n` +
    `Allowed characters: letters, numbers, - _ . (must start with letter or digit)`
  );
}

async function handleStart(ctx) {
  sessions.reset(ctx.from.id);
  const domains = strategyEngine.supportedDomains();
  await ctx.reply(
    "Welcome to Gallery Downloader Bot!\n\n" +
      "🖼 Send one or more gallery URLs (one per line) and I'll extract the " +
      "images, download them, and package them into a ZIP file.\n\n" +
      "Commands:\n" +
      "  /files  - Manage downloaded files\n" +
      "  /help   - How to use\n" +
      "  /cancel - Reset the current flow\n\n" +
      `Configured strategies: ${domains.length}\n` +
      "⚡ Auto-detection is enabled for similar gallery sites too."
  );
}

async function handleHelp(ctx) {
  const domains = strategyEngine.supportedDomains();
  await ctx.reply(
    "<b>How to use</b>\n\n" +
      "1. Send one or more gallery URLs (one per line)\n" +
      "2. Review the detected URLs and archive name\n" +
      "3. Tap <b>Start Download</b>, <b>Rename</b>, or <b>Cancel</b>\n" +
      "4. Receive your download link when the ZIP is ready\n\n" +
      "<b>Commands</b>\n" +
      "  /files  - View and manage files\n" +
      "  /cancel - Cancel current operation\n\n" +
      `Configured strategies: ${domains.length}\n` +
      "⚡ Auto-detection stays enabled for similar sites.",
    { parse_mode: "HTML" }
  );
}

async function handleCancel(ctx) {
  const session = sessions.get(ctx.from.id);
  if (session.state === sessions.STATE.PROCESSING) {
    await ctx.reply(
      "A job is currently running. Use the on-screen \"Cancel Download\" button if you want to stop it."
    );
    return;
  }
  sessions.reset(ctx.from.id);
  await ctx.reply("✅ Cancelled. Ready for new URLs.");
}

async function handleFiles(ctx) {
  const { text, keyboard } = await filesHandler.buildFilesListMessage();
  if (keyboard) await ctx.reply(text, keyboard);
  else await ctx.reply(text);
}

async function handleText(ctx) {
  const session = sessions.get(ctx.from.id);
  const text = (ctx.message.text || "").trim();

  if (session.state === sessions.STATE.WAITING_NAME) {
    if (!session.pendingJob) {
      sessions.reset(ctx.from.id);
      await ctx.reply("Session expired. Please send the URLs again.");
      return;
    }
    if (!archiveName.isValidArchiveName(text)) {
      await ctx.reply(
        "❌ Invalid name.\nMust start with a letter or digit and only contain " +
          "letters, numbers, '-', '_' or '.' (no '..' or path separators).\n\n" +
          "Please type a valid name:"
      );
      return;
    }
    session.pendingJob.archiveName = text;
    session.state = sessions.STATE.IDLE;
    await ctx.reply(
      `✅ Archive name updated to: ${text}\n\n${buildJobSummary(session)}`,
      pendingJobKeyboard("✏️ Rename Again")
    );
    return;
  }

  if (session.state === sessions.STATE.PROCESSING) {
    await ctx.reply("Already processing a job. Please wait until it finishes.");
    return;
  }

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("http"));

  if (lines.length === 0) {
    await ctx.reply(
      "No valid URLs found.\n\nPlease send gallery URLs (one per line)."
    );
    return;
  }

  const slug = jsdomScraper.extractGalleryName(lines[0]);
  const defaultName = archiveName.buildDefaultName(slug);
  session.pendingJob = { urls: lines, archiveName: defaultName };
  session.state = sessions.STATE.IDLE;
  await ctx.reply(
    `🔍 Detected ${lines.length} URL${lines.length === 1 ? "" : "s"}.\n\n` +
      buildJobSummary(session),
    pendingJobKeyboard()
  );
}

async function handleRenameAction(ctx) {
  const session = sessions.get(ctx.from.id);
  await ctx.answerCbQuery();
  if (!session.pendingJob) {
    await ctx
      .editMessageText("Session expired. Please send the URLs again.")
      .catch(() => {});
    return;
  }
  session.state = sessions.STATE.WAITING_NAME;
  await ctx
    .editMessageText(
      "✏️ Type your custom archive name:\n\n" +
        "Allowed: letters, numbers, '-', '_', '.' (must start with letter/digit)\n" +
        "Example: my-gallery_2026\n\n" +
        "Send /cancel to stop renaming."
    )
    .catch(() => {});
}

async function handleCancelPendingJob(ctx) {
  sessions.reset(ctx.from.id);
  await ctx.answerCbQuery("Cancelled.");
  await ctx
    .editMessageText("✅ Cancelled. Send new gallery URLs whenever you are ready.")
    .catch(() => {});
}

function register(bot) {
  bot.start(handleStart);
  bot.command("help", handleHelp);
  bot.command("cancel", handleCancel);
  bot.command("files", handleFiles);
  bot.action("rename_archive", handleRenameAction);
  bot.action("cancel_pending_job", handleCancelPendingJob);
  bot.on("text", handleText);
}

module.exports = { register };
