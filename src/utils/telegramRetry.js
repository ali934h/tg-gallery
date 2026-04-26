/**
 * Retry helper for Telegram calls (both Bot-API style 429s and GramJS
 * FloodWaitError) that benefit from honouring server-supplied wait hints.
 */

const logger = require("../logger");

async function retryWithBackoff(fn, maxRetries = 5, baseDelay = 1000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = (err && err.message) || "";
      const isRateLimit =
        msg.includes("429") ||
        msg.includes("Too Many Requests") ||
        msg.includes("retry after") ||
        msg.includes("FLOOD_WAIT") ||
        typeof err?.seconds === "number";
      if (!isRateLimit || attempt === maxRetries) throw err;
      let delay = baseDelay * Math.pow(2, attempt);
      const after = msg.match(/retry after (\d+)/);
      if (after) delay = Math.max(delay, parseInt(after[1], 10) * 1000);
      const flood = msg.match(/FLOOD_WAIT_(\d+)/);
      if (flood) delay = Math.max(delay, parseInt(flood[1], 10) * 1000);
      if (typeof err?.seconds === "number") {
        delay = Math.max(delay, err.seconds * 1000);
      }
      logger.warn(
        `Rate limit hit, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

module.exports = { retryWithBackoff };
