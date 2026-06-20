import 'dotenv/config';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { config, insertBuffer, getBuffer, clearBuffer, analyzeAndEnqueue } from './lib.js';

const { Client, LocalAuth } = pkg;

// --- Buffer flush timers per chat ---
const flushTimers = new Map();

function scheduleFlush(chatId, chatName) {
  if (flushTimers.has(chatId)) clearTimeout(flushTimers.get(chatId));
  const delay = config.bufferMinutes * 60 * 1000;
  const timer = setTimeout(() => flushChat(chatId, chatName), delay);
  flushTimers.set(chatId, timer);
}

async function flushChat(chatId, chatName) {
  flushTimers.delete(chatId);
  const rows = getBuffer.all(chatId);
  if (rows.length === 0) return;

  const transcript = rows
    .map((r) => `[${new Date(r.ts).toISOString()}] ${r.sender_name || r.sender}: ${r.body}`)
    .join('\n');

  clearBuffer.run(chatId);
  console.log(`[${chatName}] Flushing ${rows.length} messages to Claude...`);

  const { extracted, inserted } = await analyzeAndEnqueue(chatName, transcript);
  console.log(`[${chatName}] Extracted ${extracted} items, inserted ${inserted} with confidence >= 0.7`);
}

// --- WhatsApp client ---
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true, args: ['--no-sandbox'] },
});

client.on('qr', (qr) => {
  console.log('Scan this QR code to log in:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('WhatsApp client ready. Watching chats:', config.watchedChats);
});

client.on('message', async (msg) => {
  try {
    const chat = await msg.getChat();
    const chatName = chat.name || '';
    const isWatched = config.watchedChats.some((w) =>
      chatName.toLowerCase().includes(w.toLowerCase())
    );
    if (!isWatched) return;

    const sender = msg.author || msg.from;
    const contact = await msg.getContact();
    const senderName = contact.pushname || contact.name || sender;

    insertBuffer.run(chat.id._serialized, chatName, sender, senderName, msg.body, Date.now());
    console.log(`[${chatName}] Buffered message from ${senderName}`);
    scheduleFlush(chat.id._serialized, chatName);
  } catch (err) {
    console.error('Message handler error:', err.message);
  }
});

client.initialize();
