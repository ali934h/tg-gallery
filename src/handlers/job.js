/**
 * Long-running gallery-download job: extract images, download them, package
 * into a ZIP, reply with a direct download link, and (when the archive fits
 * Telegram's per-file cap) also send the ZIP straight to the user's chat
 * via MTProto so they can save it inside Telegram itself.
 */

const path = require("path");
const fsp = require("fs").promises;

const { Markup } = require("../tg/markup");
const config = require("../config");
const logger = require("../logger");
const fileManager = require("../fileManager");
const sessions = require("../sessions");
const filesStore = require("../files");
const archiveName = require("../archiveName");
const strategyEngine = require("../scrapers/strategyEngine");
const jsdomScraper = require("../scrapers/jsdomScraper");
const imageDownloader = require("../downloaders/imageDownloader");
const zipCreator = require("../downloaders/zipCreator");
const { retryWithBackoff } = require("../utils/telegramRetry");
const { escapeHtml } = require("../htmlEscape");

const UPDATE_INTERVAL_MS = 5000;
const UPLOAD_PROGRESS_INTERVAL_MS = 4000;

async function safeUpdateStatus(ctx, messageId, text, keyboard = null) {
  const opts = keyboard ? keyboard : {};
  await retryWithBackoff(() =>
    ctx.telegram.editMessageText(ctx.chat.id, messageId, null, text, opts)
  ).catch(() => {});
}

function cancelKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("❌ Cancel Download", "cancel_download")],
  ]);
}

async function sendZipToChat(ctx, zipPath, zipFileName, statusLabel) {
  let lastEdit = 0;
  let progressMsgId = null;

  try {
    const sent = await retryWithBackoff(() =>
      ctx.reply(`📤 Uploading <b>${escapeHtml(zipFileName)}</b> to chat...`, {
        parse_mode: "HTML",
      })
    );
    progressMsgId = sent ? sent.message_id : null;
  } catch (_e) {
    // ignore — upload still runs
  }

  try {
    await ctx.client.sendFile(ctx.chat.id, {
      file: zipPath,
      caption: `📦 ${zipFileName}\n${statusLabel}`,
      forceDocument: true,
      progressCallback: (uploaded, total) => {
        const now = Date.now();
        if (!progressMsgId || !total || now - lastEdit < UPLOAD_PROGRESS_INTERVAL_MS) {
          return;
        }
        lastEdit = now;
        const pct = ((Number(uploaded) / Number(total)) * 100).toFixed(1);
        ctx.client
          .editMessage(ctx.chat.id, {
            message: progressMsgId,
            text: `📤 Uploading <b>${escapeHtml(zipFileName)}</b>... ${pct}%`,
            parseMode: "html",
          })
          .catch(() => {});
      },
    });
    if (progressMsgId) {
      await ctx.client
        .deleteMessages(ctx.chat.id, [progressMsgId], { revoke: true })
        .catch(() => {});
    }
  } catch (err) {
    logger.error("In-chat upload failed", {
      error: err.message,
      file: zipFileName,
    });
    if (progressMsgId) {
      await ctx.client
        .editMessage(ctx.chat.id, {
          message: progressMsgId,
          text:
            `⚠️ Telegram upload failed: ${escapeHtml(err.message)}\n` +
            `Direct link is still available above.`,
          parseMode: "html",
        })
        .catch(() => {});
    }
  }
}

async function processGalleries(ctx, urls, requestedName) {
  const session = sessions.get(ctx.from.id);
  session.state = sessions.STATE.PROCESSING;
  const abortController = new AbortController();
  session.abortController = abortController;
  const { signal } = abortController;

  const status = await ctx.reply("🚀 Starting... please wait.", cancelKeyboard());
  const msgId = status.message_id;
  let tempDir = null;

  try {
    await safeUpdateStatus(
      ctx,
      msgId,
      `🔎 Extracting images from ${urls.length} ${
        urls.length === 1 ? "gallery" : "galleries"
      }...`,
      cancelKeyboard()
    );

    const galleries = [];
    const unsupportedUrls = [];

    for (let i = 0; i < urls.length; i++) {
      if (signal.aborted) break;
      const url = urls[i];
      let strategy = strategyEngine.get(url);
      const galleryName = jsdomScraper.extractGalleryName(url);

      try {
        let imageUrls = [];
        if (strategy) {
          imageUrls = await jsdomScraper.extractImages(url, strategy);
        }
        if (!strategy || imageUrls.length === 0) {
          await safeUpdateStatus(
            ctx,
            msgId,
            `🧪 Trying fallback strategies for gallery ${i + 1}/${urls.length}...`,
            cancelKeyboard()
          );
          const result = await strategyEngine.findWorking(url, jsdomScraper);
          if (result) {
            strategy = result.strategy;
            imageUrls = result.images;
          } else {
            unsupportedUrls.push(url);
            galleries.push({ name: galleryName, urls: [], useProxy: false });
            continue;
          }
        }
        galleries.push({
          name: galleryName,
          urls: imageUrls,
          useProxy: !!strategy.useProxy,
        });
        logger.info(
          `Gallery ${i + 1}/${urls.length} extracted: ${galleryName} (${imageUrls.length} images)`
        );
      } catch (err) {
        logger.warn(`Failed to extract gallery: ${url}`, { error: err.message });
        unsupportedUrls.push(url);
        galleries.push({ name: galleryName, urls: [], useProxy: false });
      }

      await safeUpdateStatus(
        ctx,
        msgId,
        `🔎 Extracting images... (${i + 1}/${urls.length} galleries done)`,
        cancelKeyboard()
      );
    }

    if (unsupportedUrls.length > 0) {
      await ctx
        .reply(
          `⚠️ Could not extract images from ${unsupportedUrls.length} URL(s).\nContinuing with successful galleries...`
        )
        .catch(() => {});
    }

    const totalImages = galleries.reduce((sum, g) => sum + g.urls.length, 0);
    if (totalImages === 0) {
      throw new Error("No images found in any of the provided galleries.");
    }

    const successfulGalleries = galleries.filter((g) => g.urls.length > 0)
      .length;
    await safeUpdateStatus(
      ctx,
      msgId,
      `✅ Found ${totalImages} images across ${successfulGalleries} ${
        successfulGalleries === 1 ? "gallery" : "galleries"
      }.\n⬇️ Downloading...`,
      cancelKeyboard()
    );

    tempDir = await fileManager.createTempDir(config.tempDir, "galleries");

    let lastUpdate = 0;
    const downloadResult = await imageDownloader.downloadMultipleGalleries(
      galleries.filter((g) => g.urls.length > 0),
      tempDir,
      (progress) => {
        const now = Date.now();
        if (now - lastUpdate < UPDATE_INTERVAL_MS) return;
        lastUpdate = now;
        safeUpdateStatus(
          ctx,
          msgId,
          `⬇️ Downloading gallery ${progress.completedGalleries + 1}/${progress.totalGalleries}\n` +
            `Current: ${progress.galleryName}\n` +
            `Progress: ${progress.galleryProgress.current}/${progress.galleryProgress.total} images`,
          cancelKeyboard()
        );
      },
      signal
    );

    if (downloadResult.successImages === 0) {
      await safeUpdateStatus(
        ctx,
        msgId,
        signal.aborted
          ? "⚠️ Cancelled. No images were downloaded yet."
          : "❌ Failed to download any images."
      );
      return;
    }

    await safeUpdateStatus(
      ctx,
      msgId,
      signal.aborted
        ? `⚠️ Cancelled. Packaging ${downloadResult.successImages} images...`
        : "📦 Creating ZIP archive..."
    );

    const finalName = archiveName.withRandomSuffix(requestedName);
    const zipPath = await zipCreator.createZip(
      tempDir,
      finalName,
      config.downloadsDir
    );
    const zipFileName = path.basename(zipPath);
    await filesStore.saveMeta(zipFileName, urls);
    const stats = await fsp.stat(zipPath);

    const downloadUrl = `${config.downloadBaseUrl}/${zipFileName}`;
    const fileSize = fileManager.formatBytes(stats.size);
    const statusLine = signal.aborted
      ? "⚠️ Partial download complete"
      : "✅ Download complete";

    const summaryMsg =
      `${statusLine}\n\n` +
      `📦 File: ${zipFileName}\n` +
      `🖼 Images: ${downloadResult.successImages}\n` +
      `💾 Size: ${fileSize}\n\n` +
      `📁 Tip: use /files to manage saved downloads.`;

    const linkMsg = `🔗 <b>Download Link:</b>\n<code>${escapeHtml(downloadUrl)}</code>`;

    await retryWithBackoff(() => ctx.reply(summaryMsg));
    await retryWithBackoff(() =>
      ctx.reply(linkMsg, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      })
    );
    await retryWithBackoff(() =>
      ctx.telegram.deleteMessage(ctx.chat.id, msgId)
    ).catch(() => {});

    if (stats.size > config.telegramMaxUploadBytes) {
      const limitGb = (config.telegramMaxUploadBytes / 1024 / 1024 / 1024).toFixed(1);
      await ctx
        .reply(
          `⚠️ Archive size (${fileSize}) exceeds Telegram's ${limitGb} GB upload limit.\n` +
            `Use the direct link above to download.`
        )
        .catch(() => {});
    } else {
      await sendZipToChat(ctx, zipPath, zipFileName, statusLine);
    }

    logger.info(`Job complete for user ${ctx.from.id}: ${zipFileName}`);
  } catch (err) {
    logger.error("Gallery processing failed", {
      error: err.message,
      user: ctx.from.id,
    });
    await safeUpdateStatus(
      ctx,
      msgId,
      `❌ Error: ${err.message}\n\nPlease check your URLs and try again.`
    );
  } finally {
    if (tempDir) await fileManager.deleteDir(tempDir);
    sessions.reset(ctx.from.id);
  }
}

function register(bot) {
  bot.action("start_download", async (ctx) => {
    const session = sessions.get(ctx.from.id);
    await ctx.answerCbQuery();
    if (!session.pendingJob) {
      await ctx
        .editMessageText("Session expired. Please send the URLs again.")
        .catch(() => {});
      return;
    }
    await ctx.deleteMessage();
    const { urls, archiveName: name } = session.pendingJob;
    session.pendingJob = null;
    await processGalleries(ctx, urls, name);
  });

  bot.action("cancel_download", async (ctx) => {
    const session = sessions.get(ctx.from.id);
    await ctx.answerCbQuery("Cancelling...");
    if (session.abortController) {
      session.abortController.abort();
      logger.info(`User ${ctx.from.id} cancelled gallery download`);
    }
  });
}

module.exports = { register, processGalleries };
