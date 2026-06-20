import 'dotenv/config';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { config, analyzeAndEnqueue } from './lib.js';

const { Client, LocalAuth } = pkg;

const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS ?? 7);
const cutoff = Date.now() - BACKFILL_DAYS * 24 * 60 * 60 * 1000;

console.log(`Backfilling last ${BACKFILL_DAYS} day(s) for chats: ${config.watchedChats.join(', ')}`);

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true, args: ['--no-sandbox'] },
});

client.on('qr', (qr) => {
  console.log('Scan this QR code to log in:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
  console.log('WhatsApp client ready. Starting backfill...\n');

  try {
    const chats = await client.getChats();

    for (const watchedName of config.watchedChats) {
      const chat = chats.find((c) =>
        (c.name || '').toLowerCase().includes(watchedName.toLowerCase())
      );

      if (!chat) {
        console.log(`[${watchedName}] No matching chat found — skipping.`);
        continue;
      }

      const chatName = chat.name || watchedName;
      console.log(`[${chatName}] Fetching up to 500 messages...`);

      let messages;
      try {
        messages = await chat.fetchMessages({ limit: 500 });
      } catch (err) {
        console.error(`[${chatName}] Failed to fetch messages:`, err.message);
        continue;
      }

      const recent = messages.filter((m) => {
        const ts = (m.timestamp || 0) * 1000;
        return ts >= cutoff && m.body && m.body.trim();
      });

      if (recent.length === 0) {
        console.log(`[${chatName}] No messages in the last ${BACKFILL_DAYS} day(s) — skipping.`);
        continue;
      }

      console.log(`[${chatName}] Analysing ${recent.length} messages...`);

      const transcript = recent
        .map((m) => {
          const ts = new Date((m.timestamp || 0) * 1000).toISOString();
          const sender = m.author || m.from || 'unknown';
          return `[${ts}] ${sender}: ${m.body}`;
        })
        .join('\n');

      const { extracted, inserted } = await analyzeAndEnqueue(chatName, transcript);
      console.log(
        `[${chatName}] Extracted ${extracted} items, inserted ${inserted} with confidence >= 0.7\n`
      );
    }
  } catch (err) {
    console.error('Backfill error:', err.message);
  }

  console.log('Backfill complete.');
  await client.destroy();
  process.exit(0);
});

client.initialize();
