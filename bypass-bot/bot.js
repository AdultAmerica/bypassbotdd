require('dotenv').config();
const http = require('http');
const { Telegraf } = require('telegraf');
const axios = require('axios');

const {
  TELEGRAM_TOKEN,
  BYPASS_API_KEY,
  TARGET_CHAT_ID,
  API_TIMEOUT,
  COOLDOWN_MS,
} = process.env;

if (!TELEGRAM_TOKEN || !BYPASS_API_KEY || !TARGET_CHAT_ID) {
  console.error('Missing required environment variables: TELEGRAM_TOKEN, BYPASS_API_KEY, TARGET_CHAT_ID');
  process.exit(1);
}

const TIMEOUT  = parseInt(API_TIMEOUT)  || 15000;
const COOLDOWN = parseInt(COOLDOWN_MS)  || 5000;

const bot = new Telegraf(TELEGRAM_TOKEN);

// userId -> timestamp of last accepted request
const cooldowns = new Map();

function getRemainingCooldown(userId) {
  const last = cooldowns.get(userId);
  if (!last) return 0;
  const remaining = COOLDOWN - (Date.now() - last);
  return remaining > 0 ? remaining : 0;
}

function extractUrl(text) {
  const match = (text || '').match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
}

async function callBypassApi(url) {
  const { data } = await axios.post(
    'https://byp.tcbl.xyz/api/bypass/recursive',
    { url },
    {
      headers: { 'X-API-KEY': BYPASS_API_KEY },
      timeout: TIMEOUT,
    }
  );
  // Accept common response shapes
  return data?.url || data?.bypassed_url || data?.result || data?.data || String(data);
}

bot.on('message', async (ctx) => {
  const msg = ctx.message;

  // Only process forwarded messages
  const isForwarded =
    msg.forward_date != null ||
    msg.forward_from != null ||
    msg.forward_from_chat != null ||
    msg.forward_origin != null;

  if (!isForwarded) return;

  const userId = ctx.from.id;
  const remaining = getRemainingCooldown(userId);

  if (remaining > 0) {
    return ctx.reply(`Slow down — wait ${Math.ceil(remaining / 1000)}s before the next request.`);
  }

  const rawText = msg.text || msg.caption || '';
  const url = extractUrl(rawText);

  if (!url) {
    return ctx.reply('No URL found in the forwarded message.');
  }

  cooldowns.set(userId, Date.now());

  let processingMsg;
  try {
    processingMsg = await ctx.reply('Bypassing…');

    const bypassedUrl = await callBypassApi(url);

    // Strip original URL from caption, append only the bypassed URL
    const cleanedText = rawText.replace(url, '').trim();
    const outCaption = cleanedText ? `${cleanedText}\n\n${bypassedUrl}` : bypassedUrl;

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
      `Done. Posted to channel.\n\nBypassed URL: ${bypassedUrl}`
    );
  } catch (err) {
    const errText = err.response?.data?.message || err.response?.data?.error || err.message;
    console.error(`[ERROR] userId=${userId} url=${url}:`, errText);

    const failMsg = `Failed: ${errText}`;
    if (processingMsg) {
      await ctx.telegram
        .editMessageText(ctx.chat.id, processingMsg.message_id, undefined, failMsg)
        .catch(() => ctx.reply(failMsg));
    } else {
      await ctx.reply(failMsg);
    }
  }
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
console.log('Bypass bot is running.');

// Railway only marks a service healthy/reachable if something answers on $PORT.
// The bot itself uses long-polling and needs no HTTP server, so this exists
// purely to satisfy Railway's health check / public networking and avoid 521s.
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => res.writeHead(200).end('OK'))
  .listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
