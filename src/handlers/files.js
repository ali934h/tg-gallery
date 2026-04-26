/**
 * Inline-keyboard handlers for the /files browser:
 *   list → details → delete + bulk delete.
 */

const { Markup } = require("../tg/markup");
const config = require("../config");
const logger = require("../logger");
const filesStore = require("../files");
const fileManager = require("../fileManager");
const { escapeHtml } = require("../htmlEscape");

async function buildFilesListMessage() {
  const files = await filesStore.listFiles();
  if (files.length === 0) {
    return { text: "No downloaded files found.", keyboard: null };
  }
  const totalSize = fileManager.formatBytes(
    files.reduce((sum, f) => sum + f.size, 0)
  );
  const text = `🗂 Downloaded files: ${files.length} total (${totalSize})`;
  const buttons = files.map((f, i) => {
    const display = f.name.substring(0, 40);
    return [Markup.button.callback(`📂 ${i + 1}. ${display}`, `fi:${i}`)];
  });
  buttons.push([Markup.button.callback("⚙️ Manage All Files", "manage_all")]);
  return { text, keyboard: Markup.inlineKeyboard(buttons) };
}

async function showFileDetails(ctx, idx) {
  const files = await filesStore.listFiles();
  if (idx < 0 || idx >= files.length) {
    await ctx.answerCbQuery("File not found.");
    const { text, keyboard } = await buildFilesListMessage();
    await ctx.editMessageText(text, keyboard || undefined).catch(() => {});
    return;
  }
  const f = files[idx];
  const size = fileManager.formatBytes(f.size);
  const date = f.date.toISOString().slice(0, 16).replace("T", " ");
  const downloadUrl = `${config.downloadBaseUrl}/${f.name}`;
  const meta = await filesStore.readMeta(f.name);

  const lines = [
    "📂 <b>File Details</b>",
    "",
    `Name: <code>${escapeHtml(f.name)}</code>`,
    `Size: ${escapeHtml(size)}`,
    `Date: ${escapeHtml(date)}`,
    "",
    "Link:",
    `<code>${escapeHtml(downloadUrl)}</code>`,
  ];
  const rows = [
    [Markup.button.callback("🗑 Delete This File", `cd:${idx}`)],
    [Markup.button.callback("⬅️ Back to List", "back_to_list")],
  ];
  if (meta && Array.isArray(meta.urls) && meta.urls.length > 0) {
    rows.unshift([Markup.button.callback("🔗 Gallery Sources", `src:${idx}`)]);
  }
  await ctx.answerCbQuery();
  await ctx
    .editMessageText(lines.join("\n"), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard(rows),
    })
    .catch(() => {});
}

async function showSources(ctx, idx) {
  const files = await filesStore.listFiles();
  if (idx < 0 || idx >= files.length) {
    await ctx.answerCbQuery("File not found.");
    return;
  }
  const f = files[idx];
  const meta = await filesStore.readMeta(f.name);
  if (!meta || !Array.isArray(meta.urls) || meta.urls.length === 0) {
    await ctx.answerCbQuery("No source URLs found.");
    return;
  }
  const text = [
    "🔗 <b>Gallery Sources</b>",
    `<code>${escapeHtml(f.name)}</code>`,
    "",
    `<code>${escapeHtml(meta.urls.join("\n"))}</code>`,
  ].join("\n");
  await ctx.answerCbQuery();
  await ctx
    .editMessageText(text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Back", `fi:${idx}`)],
      ]),
    })
    .catch(() => {});
}

async function confirmDelete(ctx, idx) {
  const files = await filesStore.listFiles();
  if (idx < 0 || idx >= files.length) {
    await ctx.answerCbQuery("File not found.");
    return;
  }
  const fileName = files[idx].name;
  await ctx.answerCbQuery();
  await ctx
    .editMessageText(
      `⚠️ Are you sure you want to delete:\n\n${fileName}?`,
      Markup.inlineKeyboard([
        [Markup.button.callback("✅ Yes, Delete", `dd:${idx}`)],
        [Markup.button.callback("❌ Cancel", `fi:${idx}`)],
      ])
    )
    .catch(() => {});
}

async function doDelete(ctx, idx) {
  const files = await filesStore.listFiles();
  if (idx < 0 || idx >= files.length) {
    await ctx.answerCbQuery("File not found.");
    return;
  }
  const fileName = files[idx].name;
  try {
    await filesStore.deleteZip(fileName);
    logger.info(`File deleted: ${fileName}`);
    await ctx.answerCbQuery("File deleted.");
    const remaining = await filesStore.listFiles();
    if (remaining.length === 0) {
      await ctx.editMessageText("✅ File deleted. No more files.");
    } else {
      const { text, keyboard } = await buildFilesListMessage();
      await ctx.editMessageText(text, keyboard);
    }
  } catch (err) {
    logger.error(`Failed to delete file: ${fileName}`, { error: err.message });
    await ctx.answerCbQuery("Failed to delete file.");
  }
}

async function manageAll(ctx) {
  const files = await filesStore.listFiles();
  const totalSize = fileManager.formatBytes(
    files.reduce((sum, f) => sum + f.size, 0)
  );
  await ctx.answerCbQuery();
  await ctx
    .editMessageText(
      `⚙️ Manage All Files\n\nTotal: ${files.length} file(s), ${totalSize}\n\nThis will permanently delete all downloaded files.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🗑 Delete ALL Files", "confirm_del_all")],
        [Markup.button.callback("⬅️ Back to List", "back_to_list")],
      ])
    )
    .catch(() => {});
}

async function confirmDeleteAll(ctx) {
  const files = await filesStore.listFiles();
  await ctx.answerCbQuery();
  await ctx
    .editMessageText(
      `⚠️ Are you sure you want to delete ALL ${files.length} file(s)?\n\nThis cannot be undone.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("✅ Yes, Delete All", "do_del_all")],
        [Markup.button.callback("❌ Cancel", "manage_all")],
      ])
    )
    .catch(() => {});
}

async function doDeleteAll(ctx) {
  const files = await filesStore.listFiles();
  let deleted = 0;
  for (const f of files) {
    try {
      await filesStore.deleteZip(f.name);
      deleted++;
    } catch (err) {
      logger.error(`Failed to delete: ${f.name}`, { error: err.message });
    }
  }
  logger.info(`Bulk delete: ${deleted}/${files.length} files removed`);
  await ctx.answerCbQuery(`Deleted ${deleted} file(s).`);
  await ctx
    .editMessageText(`✅ Done. ${deleted} file(s) deleted.`)
    .catch(() => {});
}

async function backToList(ctx) {
  await ctx.answerCbQuery();
  const { text, keyboard } = await buildFilesListMessage();
  if (keyboard) {
    await ctx.editMessageText(text, keyboard).catch(() => {});
  } else {
    await ctx.editMessageText(text).catch(() => {});
  }
}

function register(bot) {
  bot.action(/^fi:(\d+)$/, async (ctx) => {
    await showFileDetails(ctx, parseInt(ctx.match[1], 10));
  });
  bot.action(/^src:(\d+)$/, async (ctx) => {
    await showSources(ctx, parseInt(ctx.match[1], 10));
  });
  bot.action(/^cd:(\d+)$/, async (ctx) => {
    await confirmDelete(ctx, parseInt(ctx.match[1], 10));
  });
  bot.action(/^dd:(\d+)$/, async (ctx) => {
    await doDelete(ctx, parseInt(ctx.match[1], 10));
  });
  bot.action("manage_all", manageAll);
  bot.action("confirm_del_all", confirmDeleteAll);
  bot.action("do_del_all", doDeleteAll);
  bot.action("back_to_list", backToList);
}

module.exports = { register, buildFilesListMessage };
