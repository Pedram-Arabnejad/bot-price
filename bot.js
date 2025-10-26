
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const TelegramBot = require('node-telegram-bot-api');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const { exec } = require("child_process");

dotenv.config();

const DUMPS_DIR = path.join(__dirname, 'dumps');
fs.ensureDirSync(DUMPS_DIR);

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

if (!TOKEN || !CHANNEL_ID) {
  console.error('Please set TELEGRAM_TOKEN and CHANNEL_ID in .env');
  process.exit(1);
}

// const bot = new TelegramBot(TOKEN, {
//   polling: false,
//   request: { baseApiUrl: 'https://telegram-proxy.mahdyaslami.workers.dev' }
// });

// MySQL connection
async function initDB() {
  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: process.env.MYSQL_PORT || 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE
  });
  console.log('✅ MySQL connected!');


  await db.execute(`
    CREATE TABLE IF NOT EXISTS prices (
      name VARCHAR(255) PRIMARY KEY,
      value VARCHAR(255),
      updatedAt DATETIME
    )
  `);

  return db;
}

// URLs
const URLS = [
  { name: 'dollar', url: 'https://www.tgju.org/profile/price_dollar_rl', selector: 'span.price', label: '💵 دلار' },
  { name: 'gold18', url: 'https://www.tgju.org/profile/geram18', selector: 'span.price', label: '🥇 طلای ۱۸ عیار' },
  { name: 'gold24', url: 'https://www.tgju.org/profile/geram24', selector: 'span.price', label: '🥇 طلای ۲۴ عیار' },
  { name: 'ons_silver', url: 'https://www.tgju.org/profile/silver_999', selector: 'span.price', label: '🥈 نقره' },
  { name: 'melted', url: 'https://www.tgju.org/profile/gold_futures', selector: 'span.price', label: '🔥 آبشده' },
  { name: 's_bahar', url: 'https://www.tgju.org/profile/sekeb', selector: 'span.price', label: '🪙 سکه بهار آزادی' },
  { name: 's_imami', url: 'https://www.tgju.org/profile/sekee', selector: 'span.price', label: '🪙 سکه امامی' },
  { name: 's_nim', url: 'https://www.tgju.org/profile/nim', selector: 'span.price', label: '🪙 نیم سکه' },
  { name: 's_rob', url: 'https://www.tgju.org/profile/rob', selector: 'span.price', label: '🪙 ربع سکه' },
  { name: 's_gerami', url: 'https://www.tgju.org/profile/gerami', selector: 'span.price', label: '🪙 سکه گرمی' },
  { name: 'mesghal_gold', url: 'https://www.tgju.org/profile/mesghal', selector: 'span.price', label: '🏅 مثقال طلا' },
  { name: 'bitcoin', url: 'https://www.tgju.org/profile/crypto-bitcoin', selector: 'span.price', label: '🟠 بیت‌کوین' },
  { name: 'ethereum', url: 'https://www.tgju.org/profile/crypto-ethereum', selector: 'span.price', label: '🔷 اتریوم' },
];

// Fetch prices
async function fetchPrices(db) {
  console.log('🕵️‍♂️ Fetching prices...');
  const prices = {};

  for (const item of URLS) {
    try {
      const res = await fetchWithRetry(item.url, 3, 5000);
      const $ = cheerio.load(res.data);
      let raw = $(item.selector).first().text().trim().replace(/,/g, '');

      if (item.name !== 'bitcoin' && item.name !== 'ethereum') {
        if (raw.length > 1) raw = raw.slice(0, -1);
      }

      const value = raw;
      prices[item.name] = value;

      await db.execute(`
        INSERT INTO prices (name, value, updatedAt)
        VALUES (?, ?, NOW())
        ON DUPLICATE KEY UPDATE value = VALUES(value), updatedAt = NOW()
      `, [item.name, value]);

    } catch (err) {
      console.error(`Error fetching ${item.name}:`, err.message);
      prices[item.name] = 'ناموجود';
    }
  }

  return prices;
}

// Build Telegram message
async function buildMessageFromDB(db) {
  const [rows] = await db.execute('SELECT name, value FROM prices');
  let message = '💹 قیمت‌های امروز:\n\n';

  for (const item of URLS) {
    const row = rows.find(r => r.name === item.name);
    if (!row) continue;

    let value = row.value;

    if (item.name !== 'bitcoin' && item.name !== 'ethereum') {
      value = Number(value).toLocaleString('en-US'); 
      value += ' تومان';
    }

    message += `${item.label}: ${value}\n\n`; 
  }

  message += `⏰ بروزرسانی: ${new Date().toLocaleString('fa-IR')}`;
  return message;
}

// Send to Telegram
// async function sendToTelegram(db) {
//   const message = await buildMessageFromDB(db);
//   try {
//     console.log('message:',message);
//     console.log('bot Info',bot);
//     console.log('bot Info request', bot._options.request);
//     await bot.sendMessage(CHANNEL_ID, message);
//     console.log('📩 Message sent to Telegram.');
//   } catch (err) {
//     console.error('Error sending to Telegram:', err.message);
//   }
// }
async function sendToTelegram(db) {
  const message = await buildMessageFromDB(db);
  const cmd = `curl -s -X POST https://telegram-proxy.mahdyaslami.workers.dev/bot${TOKEN}/sendMessage \
    -d chat_id="${CHANNEL_ID}" \
    -d text="${message.replace(/"/g, '\\"')}"`;

  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      console.error(`❌ curl error: ${error.message}`);
      return;
    }
    if (stderr) console.error(`❌ curl stderr: ${stderr}`);
  });
}

async function fetchWithRetry(url, retries = 3, delay = 3000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url, { timeout: 10000 }); // 10s timeout
    } catch (err) {
      console.warn(`❗ Error fetching (${i + 1}/${retries}): ${err.code || err.message}`);

      if (i === retries - 1) {
        throw err; 
      }

      await new Promise(res => setTimeout(res, delay));
    }
  }
}

(async () => {
  const db = await initDB();
  await fetchPrices(db);
  console.log('price get');
  await sendToTelegram(db);
  console.log('🤖 Price Bot is running ✅');

  // Repeat every 1 hour
  setInterval(async () => {
    await fetchPrices(db);
    await sendToTelegram(db);
  }, 3600 * 1000);
})();

