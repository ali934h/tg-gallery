/**
 * Long-running gallery-download job: extract images, download them, package
 * into a ZIP, and reply with a download link.
 */

const path = require("path");
const fsp = require("fs").promises;
const { Markup } = require("telegraf");
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
const userbot = require("../userbot");

const UPDATE_INTERVAL_MS = 5000;
// Telegram caps media captions at 1024 characters. Leave a small margin for
// the trailing "…and N more" line and any HTML entity expansion in edge cases.
const CAPTION_MAX_LEN = 1000;

function buildChannelCaption(zipFileName, imageCount, sizeStr, sourceUrls) {
  const header =
    `<b>${escapeHtml(zipFileName)}</b>\n` +
    `🖼 ${imageCount} images · 💾 ${sizeStr}\n\n` +
    `<b>Sources:</b>\n`;

  const lines = [];
  let used = header.length;
  let included = 0;
  for (const url of sourceUrls) {
    const line = `• ${escapeHtml(url)}\n`;
    // Reserve ~30 chars for the trailing "…and N more" line.
    if (used + line.length > CAPTION_MAX_LEN - 30) break;
    lines.push(line);
    used += line.length;
    included++;
  }

  let caption = header + lines.join("");
  if (included < sourceUrls.length) {
    caption += `…and ${sourceUrls.length - included} more`;
  }
  return caption.length > CAPTION_MAX_LEN
    ? caption.slice(0, CAPTION_MAX_LEN - 1) + "…"
    : caption;
}

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

async function uploadToChannel(ctx, info) {
  const { zipPath, zipFileName, sourceUrls, imageCount, size } = info;
  const sizeStr = fileManager.formatBytes(size);

  if (size > config.telegramUpload.maxBytes) {
    const limitGb = (config.telegramUpload.maxBytes / 1024 / 1024 / 1024).toFixed(1);
    await retryWithBackoff(() =>
      ctx.reply(
        `⚠️ Archive size (${sizeStr}) exceeds Telegram's ${limitGb} GB upload limit. ` +
          `Use the direct link above to download.`
      )
    ).catch(() => {});
    return;
  }

  const status = await retryWithBackoff(() =>
    ctx.reply(`📤 Uploading <b>${escapeHtml(zipFileName)}</b> to channel...`, {
      parse_mode: "HTML",
    })
  ).catch(() => null);
  const statusId = status ? status.message_id : null;

  const caption = buildChannelCaption(zipFileName, imageCount, sizeStr, sourceUrls);

  let lastEdit = 0;
  try {
    await userbot.uploadFile(zipPath, caption, {
      parseMode: "html",
      onProgress: (uploaded, total) => {
        const now = Date.now();
        if (!statusId || !total || now - lastEdit < 4000) return;
        lastEdit = now;
        const pct = ((Number(uploaded) / Number(total)) * 100).toFixed(1);
        ctx.telegram
          .editMessageText(
            ctx.chat.id,
            statusId,
            null,
            `📤 Uploading <b>${escapeHtml(zipFileName)}</b>... ${pct}%`,
            { parse_mode: "HTML" }
          )
          .catch(() => {});
      },
    });
    if (statusId) {
      await retryWithBackoff(() =>
        ctx.telegram.editMessageText(
          ctx.chat.id,
          statusId,
          null,
          `📤 Uploaded <b>${escapeHtml(zipFileName)}</b> to channel.`,
          { parse_mode: "HTML" }
        )
      ).catch(() => {});
    }
  } catch (err) {
    logger.error("Channel upload failed", {
      error: err.message,
      file: zipFileName,
    });
    if (statusId) {
      await retryWithBackoff(() =>
        ctx.telegram.editMessageText(
          ctx.chat.id,
          statusId,
          null,
          `⚠️ Channel upload failed: ${escapeHtml(err.message)}\nDirect link is still available above.`,
          { parse_mode: "HTML" }
        )
      ).catch(() => {});
    } else {
      await ctx
        .reply(
          `⚠️ Channel upload failed: ${err.message}\nDirect link is still available above.`
        )
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

    if (userbot.isEnabled()) {
      await uploadToChannel(ctx, {
        zipPath,
        zipFileName,
        sourceUrls: urls,
        imageCount: downloadResult.successImages,
        size: stats.size,
      });
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
    await ctx.deleteMessage().catch(() => {});
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
