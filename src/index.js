/**
 * Application Entry Point
 * Production: HTTP on internal port (nginx handles SSL as reverse proxy)
 * Development: HTTP with polling
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('./bot');
const Logger = require('./utils/logger');
const FileManager = require('./utils/fileManager');

// Configuration
const PORT = parseInt(process.env.PORT) || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN;
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook';
const NODE_ENV = process.env.NODE_ENV || 'development';
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(process.cwd(), 'downloads');

// Validate required environment variables
if (!BOT_TOKEN) {
  Logger.error('BOT_TOKEN is not set in environment variables');
  process.exit(1);
}

if (NODE_ENV === 'production' && !WEBHOOK_DOMAIN) {
  Logger.error('WEBHOOK_DOMAIN is required in production mode');
  process.exit(1);
}

// Create Express app
const app = express();
app.use(express.json());

// Serve ZIP files as static downloads
app.use('/downloads', express.static(DOWNLOADS_DIR));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: NODE_ENV
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({
    service: 'Telegram Gallery Downloader Bot',
    version: '1.0.0',
    status: 'running'
  });
});

// Initialize bot
const bot = new TelegramBot(BOT_TOKEN);

// Cleanup scheduler: remove old temp dirs every hour
function scheduleCleanup() {
  setInterval(async () => {
    Logger.info('Running scheduled temp cleanup...');
    await FileManager.cleanupOldTempDirs();
  }, 60 * 60 * 1000);
}

// Start in production mode (HTTP internally — nginx handles SSL)
if (NODE_ENV === 'production') {
  const webhookPath = `${WEBHOOK_PATH}/${BOT_TOKEN}`;
  const webhookUrl = `${WEBHOOK_DOMAIN}${webhookPath}`;

  bot.startWebhook(WEBHOOK_DOMAIN, webhookPath)
    .then((botInstance) => {
      app.use(botInstance.webhookCallback(webhookPath));

      const server = http.createServer(app);

      server.listen(PORT, '127.0.0.1', () => {
        Logger.info(`HTTP server started in PRODUCTION mode on 127.0.0.1:${PORT}`);
        Logger.info(`Webhook URL: ${webhookUrl}`);
        Logger.info(`Downloads served at: ${WEBHOOK_DOMAIN}/downloads`);
        Logger.info('SSL is handled by nginx reverse proxy');
        scheduleCleanup();
      });

      server.on('error', (error) => {
        Logger.error('HTTP server error', { error: error.message });
        process.exit(1);
      });
    })
    .catch((error) => {
      Logger.error('Failed to start bot in production mode', { error: error.message });
      process.exit(1);
    });

// Start in development mode (HTTP + polling)
} else {
  bot.startPolling()
    .then(() => {
      Logger.info('Bot started in DEVELOPMENT mode with polling');

      const server = http.createServer(app);
      server.listen(PORT, () => {
        Logger.info(`HTTP server running on port ${PORT}`);
        Logger.info(`Downloads served at: http://localhost:${PORT}/downloads`);
        scheduleCleanup();
      });
    })
    .catch((error) => {
      Logger.error('Failed to start bot in development mode', { error: error.message });
      process.exit(1);
    });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  Logger.info('SIGTERM received: shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  Logger.info('SIGINT received: shutting down gracefully');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  Logger.error('Uncaught exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  Logger.error('Unhandled promise rejection', { reason: String(reason) });
});
