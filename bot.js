require('dotenv').config();
const http = require('http');
const { Telegraf } = require('telegraf');
const axios = require('axios');

// --- ENVIRONMENT VARIABLES ---
const {
  TELEGRAM_TOKEN,
  BYPASS_API_KEY,
  TARGET_CHAT_ID,
  API_TIMEOUT,
  ALLOWED_USERS, // New: Comma-separated list of allowed Telegram User IDs
  MAX_CONCURRENT_TASKS // New: Set how many tasks run at once
} = process.env;

if (!TELEGRAM_TOKEN || !BYPASS_API_KEY || !TARGET_CHAT_ID) {
  console.error('Missing required environment variables: TELEGRAM_TOKEN, BYPASS_API_KEY, TARGET_CHAT_ID');
  process.exit(1);
}

const TIMEOUT = parseInt(API_TIMEOUT) || 15000;
const CONCURRENCY_LIMIT = parseInt(MAX_CONCURRENT_TASKS) || 3;

// Parse the allowed users into an array of numbers
const whitelist = ALLOWED_USERS 
  ? ALLOWED_USERS.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id))
  : [];

const bot = new Telegraf(TELEGRAM_TOKEN);

// --- ASYNCHRONOUS WORKER QUEUE SYSTEM & STATE ---
const taskQueue = [];
let activeWorkers = 0;

// Track bot usage statistics
const stats = {
  processed: 0,
  failed: 0,
  startTime: Date.now()
};

function extractUrl(text) {
  const match = (text || '').match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
}

// Access Control Middleware
bot.use(async (ctx, next) => {
  if (whitelist.length > 0 && ctx.from) {
    if (!whitelist.includes(ctx.from.id)) {
      if (ctx.message && ctx.message.text && ctx.message.text.startsWith('/')) {
        return ctx.reply('⛔ You are not authorized to use this bot.');
      }
      return; // Ignore silently if it's just a random forwarded message
    }
  }
  return next();
});

// --- COMMANDS ---
bot.command('start', (ctx) => {
  ctx.reply('👋 Welcome to the Premier Bypass Bot!\n\nForward multiple posts to me, and I will queue them up, bypass their URLs, and send them to the target channel automatically.');
});

bot.command('help', (ctx) => {
  ctx.reply('🛠 **How to use:**\n1. Select 1 or more posts containing a URL.\n2. Forward them to me.\n3. I will process them in the background.\n\nCommands:\n/start - Restart the bot\n/stats - View bot performance & queue status');
});

bot.command('stats', (ctx) => {
  const uptimeSeconds = Math.floor((Date.now() - stats.startTime) / 1000);
  ctx.reply(
    `📊 **Bot Statistics**\n\n` +
    `⏱ Uptime: ${uptimeSeconds}s\n` +
    `⏳ In Queue: ${taskQueue.length}\n` +
    `⚙️ Active Workers: ${activeWorkers}/${CONCURRENCY_LIMIT}\n` +
    `✅ Processed Successfully: ${stats.processed}\n` +
    `❌ Failed Bypasses: ${stats.failed}`
  );
});

// --- API LOGIC ---
async function callBypassApi(url) {
  const { data } = await axios.post(
    'https://byp.tcbl.xyz/api/bypass/recursive',
    { url },
    {
      headers: { 'X-API-KEY': BYPASS_API_KEY },
      timeout: TIMEOUT,
    }
  );
  return data?.url || data?.bypassed_url || data?.result || data?.data || String(data);
}

// Automatically triggers whenever tasks are added to the queue
async function processQueue() {
  if (activeWorkers >= CONCURRENCY_LIMIT || taskQueue.length === 0) {
    return;
  }

  activeWorkers++;
  const task = taskQueue.shift();

  try {
    await executeBypassTask(task.ctx, task.msg, task.url, task.rawText);
    stats.processed++;
  } catch (err) {
    console.error('Queue worker execution error:', err);
    stats.failed++;
  } finally {
    activeWorkers--;
    // Enforce a 500ms safety pause between tasks to prevent Telegram rate limit issues
    setTimeout(processQueue, 500);
  }
}

// The actual bypass processing logic
async function executeBypassTask(ctx, msg, url, rawText) {
  let processingMsg;
  try {
    processingMsg = await ctx.reply('⏳ Queue processing started... Bypassing URL.');

    const bypassedUrl = await callBypassApi(url);

    // Strip original URL from caption, append only the bypassed URL
    const cleanedText = rawText.replace(url, '').trim();
    const outCaption = cleanedText ? `${cleanedText}\n\n${bypassedUrl}` : bypassedUrl;

    // Handle Photos vs Text
    if (msg.photo && msg.photo.length > 0) {
      const bestPhoto = msg.photo[msg.photo.length - 1];
      await ctx.telegram.sendPhoto(TARGET_CHAT_ID, bestPhoto.file_id, {
        caption: outCaption,
      });
    } else {
      await ctx.telegram.sendMessage(TARGET_CHAT_ID, outCaption, {
        disable_web_page_preview: false,
      });
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      undefined,
      `✅ Done. Posted to channel.\n\nBypassed URL: ${bypassedUrl}`
    );
  } catch (err) {
    const errText = err.response?.data?.message || err.response?.data?.error || err.message;
    console.error(`[ERROR] url=${url}:`, errText);

    const failMsg = `❌ Failed: ${errText}`;
    if (processingMsg) {
      await ctx.telegram
        .editMessageText(ctx.chat.id, processingMsg.message_id, undefined, failMsg)
        .catch(() => ctx.reply(failMsg));
    } else {
      await ctx.reply(failMsg);
    }
    
    // Throw error up to the worker so stats.failed increments
    throw new Error(errText); 
  }
}

// --- TELEGRAM MESSAGE HANDLER ---
bot.on('message', async (ctx) => {
  const msg = ctx.message;

  // Only process forwarded messages
  const isForwarded =
    msg.forward_date != null ||
    msg.forward_from != null ||
    msg.forward_from_chat != null ||
    msg.forward_origin != null;

  if (!isForwarded) return;

  const rawText = msg.text || msg.caption || '';
  const url = extractUrl(rawText);

  if (!url) {
    return ctx.reply('⚠️ No URL found in this forwarded message.');
  }

  // Acknowledge receipt immediately so the user knows it's queued
  await ctx.reply(`📥 Added to queue (Position: ${taskQueue.length + 1})`);

  // Push task into the queue
  taskQueue.push({ ctx, msg, url, rawText });

  // Kickstart worker processing
  processQueue();
});

// Telegram allows only one long-polling connection per bot token, so an
// overlapping instance (e.g. the old and new containers during a Railway
// redeploy) makes launch() reject with a 409 Conflict. Without this catch
// that rejection is unhandled and crashes the process; catching it lets
// Railway's restart policy recover cleanly once the old instance is gone.
bot.launch().catch((err) => {
  console.error('Bot failed to launch:', err.message || err);
  process.exit(1);
});
console.log(`🚀 Premier Asynchronous Bypass bot is running with ${CONCURRENCY_LIMIT} max workers.`);

// Railway only marks a service healthy/reachable if something answers on $PORT.
// The bot itself uses long-polling and needs no HTTP server, so this exists
// purely to satisfy Railway's health check / public networking and avoid 521s.
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => res.writeHead(200).end('OK'))
  .listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
