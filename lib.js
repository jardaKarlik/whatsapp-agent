import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

export const config = JSON.parse(readFileSync('./config.json', 'utf8'));

export const db = new Database('queue.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS message_buffer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    chat_name TEXT NOT NULL,
    sender TEXT NOT NULL,
    sender_name TEXT,
    body TEXT NOT NULL,
    ts INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    datetime TEXT,
    chat_name TEXT,
    raw_messages TEXT,
    confidence REAL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL
  );
`);

// Migrations for existing databases
try { db.exec('ALTER TABLE message_buffer ADD COLUMN sender_name TEXT'); } catch {}
try { db.exec('ALTER TABLE queue ADD COLUMN confidence REAL'); } catch {}

export const insertBuffer = db.prepare(
  'INSERT INTO message_buffer (chat_id, chat_name, sender, sender_name, body, ts) VALUES (?, ?, ?, ?, ?, ?)'
);
export const getBuffer = db.prepare(
  'SELECT * FROM message_buffer WHERE chat_id = ? ORDER BY ts ASC'
);
export const clearBuffer = db.prepare('DELETE FROM message_buffer WHERE chat_id = ?');
export const insertQueue = db.prepare(
  `INSERT INTO queue (type, title, description, datetime, chat_name, raw_messages, status, confidence, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Runs Claude analysis on a transcript string and inserts qualifying items into the queue.
 * confidence >= 0.7  → status 'pending'
 * confidence 0.4–0.69 → status 'possible'
 * @param {string} chatName
 * @param {string} transcript  Pre-formatted "[ISO] sender: body" lines joined by \n
 * @returns {Promise<{extracted: number, inserted: number}>}
 */
export async function analyzeAndEnqueue(chatName, transcript) {
  let items = [];
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Analyze this WhatsApp chat transcript and extract actionable items. Detect all of the following:

1. Commitments - personal pledges someone makes to do something
   Examples: "I'll send the report", "I'll call you tomorrow", "zavolám ti", "pošlu ti to"

2. Events - scheduled meetings or activities with a specific date/time
   Examples: "let's meet Friday", "sejdeme se v pátek", "meeting at 3pm"

3. Questions about plans that received agreement - even implicit agreement counts
   Positive responses include: ok, sure, yes, sounds good, jo, jo super, super, dobře, jasně, určitě, ok tak, v pohodě
   Example: "vylet do kina?" + "jo super" = event (cinema trip)

4. Suggestions that were not rejected - if someone proposes something and there's no pushback
   Example: "we could grab lunch" with no objection = potential commitment

5. Invitations with a positive response anywhere in the transcript
   Example: "come to my birthday" + "I'll be there" = event

Return a JSON array only (no other text). Each item must have:
- type: "commitment" or "event"
- title: short title (max 60 chars)
- description: brief description including who said what
- datetime: ISO 8601 string if a date/time was mentioned, otherwise null
- confidence: number 0-1 (use 0.7+ for clear explicit items, 0.4-0.69 for implicit or uncertain ones)

Transcript:
${transcript}`,
        },
      ],
    });

    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) items = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error(`[${chatName}] Claude error:`, err.message);
    return { extracted: 0, inserted: 0 };
  }

  const now = Date.now();
  let inserted = 0;
  for (const item of items) {
    if (item.confidence >= 0.7) {
      insertQueue.run(
        item.type, item.title, item.description ?? null,
        item.datetime ?? null, chatName, transcript, 'pending', item.confidence, now
      );
      inserted++;
    } else if (item.confidence >= 0.4) {
      insertQueue.run(
        item.type, item.title, item.description ?? null,
        item.datetime ?? null, chatName, transcript, 'possible', item.confidence, now
      );
      inserted++;
    }
  }
  return { extracted: items.length, inserted };
}
