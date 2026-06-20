import 'dotenv/config';
import express from 'express';
import Database from 'better-sqlite3';
import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const app = express();
app.use(express.json());

const db = new Database('queue.db');

db.exec(`
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

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

try { db.exec('ALTER TABLE queue ADD COLUMN confidence REAL'); } catch {}

const getPending  = db.prepare("SELECT * FROM queue WHERE status = 'pending' ORDER BY created_at DESC");
const getPossible = db.prepare("SELECT * FROM queue WHERE status = 'possible' ORDER BY created_at DESC");
const getDone     = db.prepare("SELECT * FROM queue WHERE status NOT IN ('pending','possible') ORDER BY created_at DESC LIMIT 50");
const getById     = db.prepare('SELECT * FROM queue WHERE id = ?');
const setStatus   = db.prepare('UPDATE queue SET status = ? WHERE id = ?');
const updateItem  = db.prepare('UPDATE queue SET title = ?, description = ?, datetime = ? WHERE id = ?');

const getAllComments = db.prepare('SELECT * FROM comments ORDER BY created_at ASC');
const getComments   = db.prepare('SELECT * FROM comments WHERE queue_id = ? ORDER BY created_at ASC');
const insertComment = db.prepare('INSERT INTO comments (queue_id, text, created_at) VALUES (?, ?, ?)');

// --- Google OAuth2 ---
let credentials;
try {
  credentials = JSON.parse(readFileSync('./credentials.json', 'utf8'));
} catch {
  console.warn('credentials.json not found — Google integration disabled');
}

function makeOAuth2Client() {
  if (!credentials) return null;
  const { client_id, client_secret, redirect_uris } = credentials.web || credentials.installed || {};
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

function loadTokens(oauth2Client) {
  if (!oauth2Client) return false;
  if (!existsSync('./tokens.json')) return false;
  try {
    const tokens = JSON.parse(readFileSync('./tokens.json', 'utf8'));
    oauth2Client.setCredentials(tokens);
    return true;
  } catch { return false; }
}

function saveTokens(tokens) {
  writeFileSync('./tokens.json', JSON.stringify(tokens, null, 2));
}

// --- Google Calendar helper ---
async function createCalendarEvent(oauth2Client, item) {
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  let start;
  if (item.datetime) {
    start = new Date(item.datetime);
  } else {
    start = new Date();
    start.setDate(start.getDate() + 1);
    start.setHours(10, 0, 0, 0);
  }
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: { summary: item.title, description: item.description || '', start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } },
  });
  return res.data;
}

// --- Google Tasks helper ---
async function createGoogleTask(oauth2Client, item) {
  const tasks = google.tasks({ version: 'v1', auth: oauth2Client });
  const listsRes = await tasks.tasklists.list();
  let taskListId = null;
  for (const list of listsRes.data.items || []) {
    if (list.title === 'WhatsApp') { taskListId = list.id; break; }
  }
  if (!taskListId) {
    const newList = await tasks.tasklists.insert({ requestBody: { title: 'WhatsApp' } });
    taskListId = newList.data.id;
  }
  const res = await tasks.tasks.insert({
    tasklist: taskListId,
    requestBody: { title: item.title, notes: item.description || '', due: item.datetime ? new Date(item.datetime).toISOString() : undefined },
  });
  return res.data;
}

// --- Routes ---
app.get('/auth', (req, res) => {
  const oauth2Client = makeOAuth2Client();
  if (!oauth2Client) return res.status(500).send('credentials.json not configured');
  res.redirect(oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/tasks'],
  }));
});

app.get('/oauth2callback', async (req, res) => {
  const oauth2Client = makeOAuth2Client();
  if (!oauth2Client) return res.status(500).send('credentials.json not configured');
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    saveTokens(tokens);
    res.send('<script>window.location="/"</script>');
  } catch (err) { res.status(500).send('OAuth error: ' + err.message); }
});

app.get('/api/queue',    (req, res) => res.json(getPending.all()));
app.get('/api/possible', (req, res) => res.json(getPossible.all()));
app.get('/api/done',     (req, res) => res.json(getDone.all()));

app.get('/api/comments',     (req, res) => res.json(getAllComments.all()));
app.get('/api/comments/:id', (req, res) => res.json(getComments.all(req.params.id)));
app.post('/api/comments/:id', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  const info = insertComment.run(req.params.id, text.trim(), Date.now());
  res.json({ id: info.lastInsertRowid, queue_id: Number(req.params.id), text: text.trim(), created_at: Date.now() });
});

app.patch('/api/item/:id', (req, res) => {
  const item = getById.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  updateItem.run(req.body.title ?? item.title, req.body.description ?? item.description, req.body.datetime ?? item.datetime, item.id);
  res.json({ ok: true });
});

app.post('/api/approve/:id', async (req, res) => {
  const item = getById.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const merged = { ...item, title: req.body.title ?? item.title, description: req.body.description ?? item.description, datetime: req.body.datetime ?? item.datetime };
  const oauth2Client = makeOAuth2Client();
  if (!loadTokens(oauth2Client)) return res.status(400).json({ error: 'Not authenticated with Google. Visit /auth first.' });
  try {
    if (merged.type === 'event') await createCalendarEvent(oauth2Client, merged);
    else await createGoogleTask(oauth2Client, merged);
    setStatus.run('approved', item.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/reject/:id', (req, res) => {
  const item = getById.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  setStatus.run('rejected', item.id);
  res.json({ ok: true });
});

// --- HTML UI ---
function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp Agent</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; overflow: hidden; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #000; }

/* canvas */
#bg { position: fixed; inset: 0; z-index: 0; display: block; }

/* floaters layer */
#fc { position: fixed; inset: 0; z-index: 10; pointer-events: none; }

.floater {
  position: absolute;
  border-radius: 18px;
  overflow: hidden;
  cursor: pointer;
  pointer-events: auto;
  transition: filter 0.8s ease-out;
  will-change: transform;
}
.floater-img {
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
  pointer-events: none;
  user-select: none;
}
.floater-badge {
  position: absolute;
  top: 10px; left: 10px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .05em;
  text-transform: uppercase;
  backdrop-filter: blur(8px) saturate(1.4);
  -webkit-backdrop-filter: blur(8px) saturate(1.4);
  background: rgba(0,0,0,0.45);
  color: #fff;
  border: 1px solid rgba(255,255,255,0.18);
}
.floater-overlay {
  position: absolute; bottom: 0; left: 0; right: 0;
  background: linear-gradient(to top, rgba(0,0,0,0.82) 0%, rgba(0,0,0,0) 100%);
  padding: 28px 12px 12px;
}
.floater-title {
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.floater-sub {
  color: rgba(255,255,255,0.6);
  font-size: 10px;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* overlay */
#overlay {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0,0,0,0);
  display: flex; align-items: center; justify-content: center;
  pointer-events: none;
  transition: background 0.3s;
}
#overlay.active {
  background: rgba(0,0,0,0.72);
  pointer-events: auto;
}

/* detail wrapper - handles zoom animation */
#dw {
  opacity: 0;
  transform: scale(0.85);
  transition: opacity 0.32s cubic-bezier(0.34,1.56,0.64,1),
              transform 0.32s cubic-bezier(0.34,1.56,0.64,1);
  pointer-events: none;
  width: 100%;
  max-width: 460px;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
}
#dw.open {
  opacity: 1;
  transform: scale(1);
  pointer-events: auto;
}

/* detail card */
#dc {
  background: #1C0E04;
  border-radius: 20px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: 88vh;
  box-shadow: 0 24px 64px rgba(0,0,0,0.7), 0 0 0 1px rgba(184,171,56,0.15);
}

/* hero */
#dh {
  position: relative;
  height: 160px;
  flex-shrink: 0;
}
#dhi {
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
}
#dhg {
  position: absolute; inset: 0;
  background: linear-gradient(to top, rgba(28,14,4,0.95) 0%, rgba(28,14,4,0.1) 60%, transparent 100%);
}
#dht {
  position: absolute; bottom: 12px; left: 16px; right: 16px;
  z-index: 2;
  color: #fff;
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.35;
  outline: none;
  text-shadow: 0 1px 8px rgba(0,0,0,0.7);
  border-bottom: 1px dashed rgba(255,255,255,0.25);
  padding-bottom: 2px;
}
#dht:focus { border-bottom-color: #B8AB38; }
#dht:empty::before { content: attr(data-ph); opacity: 0.45; }

/* detail body */
#db {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  scrollbar-width: thin;
  scrollbar-color: #3d2415 transparent;
}
#db::-webkit-scrollbar { width: 4px; }
#db::-webkit-scrollbar-thumb { background: #3d2415; border-radius: 4px; }

.did {
  display: flex; align-items: center; gap: 12px;
  margin-bottom: 16px;
}
#da {
  width: 38px; height: 38px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 800; color: #1C0E04;
  flex-shrink: 0;
}
.did-info { flex: 1; min-width: 0; }
.did-name { color: #e8d5b0; font-weight: 700; font-size: .9rem; }
.did-chip {
  display: inline-flex; align-items: center;
  margin-top: 3px;
  padding: 2px 8px; border-radius: 999px;
  font-size: 10px; font-weight: 800; letter-spacing: .05em;
  text-transform: uppercase;
}
.chip-event    { background: rgba(127,119,221,0.22); color: #b8b4f0; border: 1px solid rgba(127,119,221,0.3); }
.chip-task     { background: rgba(34,197,94,0.18);  color: #6ee7a0; border: 1px solid rgba(34,197,94,0.25); }
.chip-possible { background: rgba(239,159,39,0.18); color: #f5c96d; border: 1px solid rgba(239,159,39,0.25); }

.dlbl {
  display: block;
  font-size: 10px; font-weight: 700; letter-spacing: .06em;
  text-transform: uppercase; color: #7a5c3a;
  margin-bottom: 5px;
}
.dfield { margin-bottom: 12px; }
#ddesc, #db input[type=text], #db input[type=datetime-local] {
  width: 100%; padding: 8px 10px;
  background: #2a1a10; border: 1px solid #3d2415; border-radius: 8px;
  color: #e8d5b0; font-size: .87rem; font-family: inherit;
  transition: border-color .15s;
}
#ddesc { resize: vertical; min-height: 60px; }
#ddesc:focus, #db input:focus { outline: none; border-color: #B8AB38; }

.ddt-row { display: flex; gap: 8px; align-items: flex-end; margin-bottom: 12px; }
.ddt-row .dfield { flex: 1; margin-bottom: 0; }
.btn-save {
  padding: 8px 14px; background: #3d2415; color: #e8d5b0;
  border: 1px solid #5a3520; border-radius: 8px;
  font-size: .82rem; font-weight: 600; cursor: pointer;
  white-space: nowrap; height: 36px;
}
.btn-save:hover { background: #4d2e1a; }

details { margin-bottom: 12px; }
details summary {
  font-size: .78rem; color: #7a5c3a; cursor: pointer; user-select: none;
  padding: 4px 0; list-style: none;
}
details summary:hover { color: #B8AB38; }
details summary::before { content: '▸ '; font-size: .7rem; }
details[open] summary::before { content: '▾ '; }
.raw-box {
  margin-top: 6px; padding: 10px; border-radius: 8px;
  background: #120a03; border: 1px solid #2a1a10;
  font-size: .72rem; font-family: 'SF Mono','Fira Code',monospace;
  white-space: pre-wrap; max-height: 130px; overflow-y: auto;
  color: #8a6a4a; line-height: 1.55;
}

.dnotes { margin-top: 4px; }
.notes-lbl { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #7a5c3a; margin-bottom: 8px; }
#dcmts { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.cmt-bubble {
  background: #2a1a10; border-radius: 10px; padding: 8px 10px;
  font-size: .82rem; color: #d4b896; line-height: 1.4;
}
.cmt-ts { font-size: .68rem; color: #5a3a1a; margin-right: 6px; }
.cmt-row { display: flex; gap: 8px; }
.cmt-row input[type=text] {
  flex: 1; padding: 7px 10px;
  background: #2a1a10; border: 1px solid #3d2415; border-radius: 8px;
  color: #e8d5b0; font-size: .82rem; font-family: inherit;
}
.cmt-row input:focus { outline: none; border-color: #B8AB38; }
.btn-send {
  padding: 7px 14px; background: #B8AB38; color: #1C0E04;
  border: none; border-radius: 8px;
  font-size: .82rem; font-weight: 700; cursor: pointer;
  white-space: nowrap;
}
.btn-send:hover { background: #cfc044; }

/* action row */
#dact {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 16px;
  background: #120a03;
  border-top: 1px solid #2a1a10;
  flex-shrink: 0;
}
.btn-close {
  padding: 8px 14px; background: transparent; color: #7a5c3a;
  border: 1px solid #3d2415; border-radius: 8px;
  font-size: .84rem; font-weight: 600; cursor: pointer;
}
.btn-close:hover { color: #e8d5b0; border-color: #5a3520; }
.btn-dismiss {
  padding: 8px 14px; background: transparent; color: #7a5c3a;
  border: 1px solid #3d2415; border-radius: 8px;
  font-size: .84rem; font-weight: 600; cursor: pointer;
}
.btn-dismiss:hover { background: #3d0a0a; color: #ff8080; border-color: #7a1a1a; }
.cpill {
  flex: 1; text-align: center;
  font-size: .75rem; font-weight: 700;
  color: #7a5c3a; letter-spacing: .04em;
}
.btn-approve {
  padding: 8px 18px; background: #B8AB38; color: #1C0E04;
  border: none; border-radius: 8px;
  font-size: .84rem; font-weight: 800; cursor: pointer;
}
.btn-approve:hover { background: #cfc044; }

/* toast */
#toast {
  position: fixed; bottom: 24px; right: 24px; z-index: 200;
  background: #B8AB38; color: #1C0E04;
  padding: 10px 18px; border-radius: 10px;
  font-size: .88rem; font-weight: 700;
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
  opacity: 0; pointer-events: none;
  transform: translateY(8px);
  transition: opacity .25s, transform .25s;
}
#toast.show { opacity: 1; transform: translateY(0); }
</style>
</head>
<body>
<canvas id="bg"></canvas>
<div id="fc"></div>

<div id="overlay">
  <div id="dw">
    <div id="dc">
      <div id="dh">
        <img id="dhi" src="" alt="">
        <div id="dhg"></div>
        <div id="dht" contenteditable="true" data-ph="Title"></div>
      </div>
      <div id="db">
        <div class="did">
          <div id="da"></div>
          <div class="did-info">
            <div class="did-name" id="dcn"></div>
            <div id="dchip"></div>
          </div>
        </div>
        <div class="dfield">
          <label class="dlbl">Description</label>
          <textarea id="ddesc"></textarea>
        </div>
        <div class="ddt-row">
          <div class="dfield">
            <label class="dlbl">Date &amp; Time</label>
            <input type="datetime-local" id="ddt">
          </div>
          <button class="btn-save" onclick="saveDetail()">Save</button>
        </div>
        <details>
          <summary>Chat context</summary>
          <div class="raw-box" id="draw"></div>
        </details>
        <div class="dnotes">
          <div class="notes-lbl">Notes</div>
          <div id="dcmts"></div>
          <div class="cmt-row">
            <input type="text" id="dcmt" placeholder="Add a note…">
            <button class="btn-send" onclick="sendComment()">Send</button>
          </div>
        </div>
      </div>
      <div id="dact">
        <button class="btn-close"   onclick="closeDetail()">Close</button>
        <button class="btn-dismiss" onclick="dismissDetail()">Dismiss</button>
        <span  class="cpill" id="dconf"></span>
        <button class="btn-approve" onclick="approveDetail()">Approve</button>
      </div>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
// ── utils ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function toLocalInput(iso) {
  if (!iso) return '';
  try {
    var d = new Date(iso), p = function(n){ return String(n).padStart(2,'0'); };
    return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes());
  } catch(e) { return ''; }
}
function fmtTs(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  return d.toLocaleDateString()+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
}
function getInitials(name) {
  return (name||'?').split(' ').slice(0,2).map(function(w){return w[0]||'';}).join('').toUpperCase()||'?';
}
function avatarColor(name) {
  var pal = ['#B8AB38','#7F77DD','#22c55e','#3b82f6','#ec4899','#14b8a6'];
  var h = 0, s = name||'';
  for (var i=0;i<s.length;i++) h = s.charCodeAt(i)+((h<<5)-h);
  return pal[Math.abs(h)%pal.length];
}
function extractKeyword(title) {
  var stop = 'a an the to for with and or in on at my our your is are will was has have of from about that this it be get go do did make call send meet see talk zavolat poslat sejit'.split(' ');
  var words = (title||'').toLowerCase().replace(/[^a-z0-9\s]/g,'').split(/\s+/)
    .filter(function(w){ return w.length>2 && stop.indexOf(w)===-1; });
  return encodeURIComponent(words[0] || (title||'nature').split(' ')[0]);
}
function confLabel(item) {
  if (item.confidence!=null) return Math.round(item.confidence*100)+'% confidence';
  return item.status==='pending' ? '≥70% confidence' : '40–69% confidence';
}
function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(function(){ t.classList.remove('show'); }, 2800);
}

// ── canvas background ──────────────────────────────────────────────────────
var canvas = document.getElementById('bg');
var ctx    = canvas.getContext('2d');
var noiseT = Math.random() * 100;

// Random per page-load gradient params
var gradAngle = Math.random() * Math.PI * 2;
var COLORS    = ['#550003','#B8AB38','#E0D794'];
if (Math.random() > 0.5) COLORS = [COLORS[2], COLORS[1], COLORS[0]];
var midStop   = 0.32 + Math.random() * 0.36;

var SP = [ // spotlight params: [phase_x, phase_y, radius_ratio, r, g, b, alpha, speed]
  [Math.random()*6.28, Math.random()*6.28, 0.38, 85,  0,   3,   0.52, 0.14],
  [Math.random()*6.28, Math.random()*6.28, 0.30, 184, 171, 56,  0.40, 0.22],
  [Math.random()*6.28, Math.random()*6.28, 0.22, 224, 215, 148, 0.32, 0.31]
];

function resizeBg() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeBg();
window.addEventListener('resize', resizeBg);

function drawBg() {
  var W = canvas.width, H = canvas.height;
  var len = Math.sqrt(W*W+H*H);
  var cx = W/2, cy = H/2;
  var grd = ctx.createLinearGradient(
    cx - Math.cos(gradAngle)*len/2, cy - Math.sin(gradAngle)*len/2,
    cx + Math.cos(gradAngle)*len/2, cy + Math.sin(gradAngle)*len/2
  );
  grd.addColorStop(0,       COLORS[0]);
  grd.addColorStop(midStop, COLORS[1]);
  grd.addColorStop(1,       COLORS[2]);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, W, H);

  for (var i=0; i<SP.length; i++) {
    var sp = SP[i];
    var sx = cx + Math.cos(noiseT*sp[7]          + sp[0]) * W*0.32;
    var sy = cy + Math.sin(noiseT*sp[7]*0.73     + sp[1]) * H*0.32;
    var r  = Math.max(W,H) * sp[2];
    var rg = ctx.createRadialGradient(sx,sy,0, sx,sy,r);
    rg.addColorStop(0, 'rgba('+sp[3]+','+sp[4]+','+sp[5]+','+sp[6]+')');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0,0,W,H);
  }
}

// ── floaters ───────────────────────────────────────────────────────────────
var floaterObjs = [];
var floaterMap  = {}; // id → obj
var fc = document.getElementById('fc');

function buildFloater(item) {
  var w = 140 + Math.floor(Math.random()*41);   // 140-180
  var h = 160 + Math.floor(Math.random()*31);   // 160-190
  var W = window.innerWidth, H = window.innerHeight;
  var x = Math.random() * Math.max(0, W - w);
  var y = Math.random() * Math.max(0, H - h - 30);

  var maxSpd = item.status==='possible' ? 0.45 : 0.95;
  var vx = (Math.random()*2-1) * maxSpd;
  var vy = (Math.random()*2-1) * maxSpd * 0.55;
  if (Math.abs(vx)<0.18) vx = (vx<0?-1:1)*0.18;
  if (Math.abs(vy)<0.08) vy = (vy<0?-1:1)*0.08;

  var kw     = extractKeyword(item.title);
  var imgUrl = 'https://source.unsplash.com/400x300/?'+kw;

  var badgeLabel = item.status==='possible' ? 'Possible' : (item.type==='event' ? 'Event' : 'Task');
  var el = document.createElement('div');
  el.className = 'floater';
  el.style.cssText = 'width:'+w+'px;height:'+h+'px;left:'+x+'px;top:'+y+'px;';
  el.innerHTML =
    '<img class="floater-img" src="'+imgUrl+'" alt="'+esc(item.title)+'">' +
    '<div class="floater-badge">'+esc(badgeLabel)+'</div>' +
    '<div class="floater-overlay">' +
      '<div class="floater-title">'+esc(item.title)+'</div>' +
      '<div class="floater-sub">'+esc(item.chat_name||'')+'</div>' +
    '</div>';

  el.addEventListener('click', function(){ openDetail(item.id); });
  fc.appendChild(el);

  var obj = {
    el:el, item:item, x:x, y:y, vx:vx, vy:vy, w:w, h:h,
    sinOffset: Math.random()*Math.PI*2,
    sinAmp:    0.18 + Math.random()*0.28,
    hidden:    false,
    speedMult: 1.0,
    boostEnd:  0,
    boosting:  false
  };
  floaterObjs.push(obj);
  floaterMap[item.id] = obj;
  return obj;
}

function boostFloater(id) {
  var f = floaterMap[id];
  if (!f) return;
  f.speedMult = 1.6;
  f.boosting  = true;
  f.boostEnd  = Date.now() + 2500;
  f.el.style.transition = 'none';
  f.el.style.filter = 'brightness(1.4) saturate(1.3)';
}

// ── animation loop ─────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  noiseT += 0.008;
  drawBg();

  var W = window.innerWidth, H = window.innerHeight;
  var now = Date.now();

  for (var i=0; i<floaterObjs.length; i++) {
    var f = floaterObjs[i];
    if (f.hidden) continue;

    // Speed boost decay
    if (f.boosting && now > f.boostEnd) {
      f.boosting = false;
    }
    if (!f.boosting && f.speedMult > 1.0) {
      f.speedMult += (1.0 - f.speedMult) * 0.035; // lerp towards 1
      if (f.speedMult < 1.005) {
        f.speedMult = 1.0;
        f.el.style.transition = 'filter 0.8s ease-out';
        f.el.style.filter = '';
      } else {
        var t = (f.speedMult - 1.0) / 0.6;
        f.el.style.transition = 'none';
        f.el.style.filter =
          'brightness('+(1+0.4*t).toFixed(3)+') saturate('+(1+0.3*t).toFixed(3)+')';
      }
    }

    var sm = f.speedMult;
    f.x += f.vx * sm;
    f.y += f.vy * sm + f.sinAmp * Math.sin(noiseT * 1.1 + f.sinOffset);

    // Bounce
    if (f.x < 0)        { f.x = 0;        f.vx =  Math.abs(f.vx); }
    if (f.x+f.w > W)    { f.x = W-f.w;    f.vx = -Math.abs(f.vx); }
    if (f.y < 0)        { f.y = 0;         f.vy =  Math.abs(f.vy); }
    if (f.y+f.h > H-10) { f.y = H-f.h-10; f.vy = -Math.abs(f.vy); }

    f.el.style.left = f.x.toFixed(1) + 'px';
    f.el.style.top  = f.y.toFixed(1) + 'px';

    // Dynamic shadow based on current speed
    var spd  = Math.sqrt(f.vx*f.vx + f.vy*f.vy) * sm;
    var blur = (8 + spd*10).toFixed(0);
    var alph = Math.min(0.6, 0.25 + spd*0.1).toFixed(2);
    f.el.style.boxShadow = '0 '+blur+'px '+(blur*1.8).toFixed(0)+'px rgba(0,0,0,'+alph+')';
  }
}

// ── detail card state ──────────────────────────────────────────────────────
var currentId       = null;
var commentsCache   = {};  // id → [comments]

function openDetail(id) {
  var f = floaterMap[id];
  if (!f) return;
  currentId = id;
  var item = f.item;

  // Fade out floater
  f.el.style.transition = 'opacity 0.2s';
  f.el.style.opacity = '0';
  f.hidden = true;
  setTimeout(function(){ f.el.style.pointerEvents = 'none'; }, 220);

  // Populate hero
  var kw = extractKeyword(item.title);
  document.getElementById('dhi').src = 'https://source.unsplash.com/800x320/?'+kw;
  document.getElementById('dht').textContent = item.title;

  // Avatar
  var av = document.getElementById('da');
  av.textContent = getInitials(item.chat_name);
  av.style.background = avatarColor(item.chat_name);

  // Identity
  document.getElementById('dcn').textContent = item.chat_name || '';

  // Type chip
  var chipEl = document.getElementById('dchip');
  var chipClass = item.type==='event' ? 'did-chip chip-event' : 'did-chip chip-task';
  var chipLabel = item.type==='event' ? 'Event' : 'Task';
  if (item.status==='possible') {
    chipEl.innerHTML = '<span class="did-chip chip-event">'+chipLabel+'</span> <span class="did-chip chip-possible">Possible</span>';
  } else {
    chipEl.innerHTML = '<span class="'+chipClass+'">'+chipLabel+'</span>';
  }

  // Fields
  document.getElementById('ddesc').value = item.description || '';
  document.getElementById('ddt').value   = toLocalInput(item.datetime);
  document.getElementById('draw').textContent = item.raw_messages || '';
  document.getElementById('dconf').textContent = confLabel(item);

  // Comments
  loadComments(id);

  // Show overlay
  var overlay = document.getElementById('overlay');
  var dw      = document.getElementById('dw');
  overlay.classList.add('active');
  requestAnimationFrame(function(){
    requestAnimationFrame(function(){ dw.classList.add('open'); });
  });
}

function closeDetail() {
  var overlay = document.getElementById('overlay');
  var dw      = document.getElementById('dw');
  dw.classList.remove('open');
  setTimeout(function(){
    overlay.classList.remove('active');
    // Restore floater
    var f = floaterMap[currentId];
    if (f) {
      f.hidden = false;
      f.el.style.pointerEvents = 'auto';
      f.el.style.transition = 'opacity 0.25s';
      f.el.style.opacity = '1';
      boostFloater(currentId);
    }
    currentId = null;
  }, 320);
}

async function approveDetail() {
  if (!currentId) return;
  var title = document.getElementById('dht').textContent.trim();
  var desc  = document.getElementById('ddesc').value.trim();
  var dtVal = document.getElementById('ddt').value;
  var dt    = dtVal ? new Date(dtVal).toISOString() : null;
  try {
    var res  = await fetch('/api/approve/'+currentId, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({title:title, description:desc, datetime:dt})
    });
    var data = await res.json();
    if (data.error) { showToast('Error: '+data.error); return; }
    showToast('Added to Google!');
    removeFloater(currentId);
    closeDetail();
  } catch(e) { showToast('Network error'); }
}

async function dismissDetail() {
  if (!currentId) return;
  try {
    await fetch('/api/reject/'+currentId, {method:'POST'});
    showToast('Dismissed.');
    removeFloater(currentId);
    closeDetail();
  } catch(e) { showToast('Network error'); }
}

async function saveDetail() {
  if (!currentId) return;
  var title = document.getElementById('dht').textContent.trim();
  var desc  = document.getElementById('ddesc').value.trim();
  var dtVal = document.getElementById('ddt').value;
  var dt    = dtVal ? new Date(dtVal).toISOString() : null;
  try {
    await fetch('/api/item/'+currentId, {
      method:'PATCH', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({title:title, description:desc, datetime:dt})
    });
    // Also update the floater label live
    var f = floaterMap[currentId];
    if (f) {
      f.item.title = title;
      f.item.description = desc;
      f.item.datetime = dt;
      var titleEl = f.el.querySelector('.floater-title');
      if (titleEl) titleEl.textContent = title;
    }
    showToast('Saved.');
  } catch(e) { showToast('Save failed.'); }
}

function removeFloater(id) {
  var f = floaterMap[id];
  if (!f) return;
  f.hidden = true;
  f.el.style.transition = 'opacity 0.3s';
  f.el.style.opacity = '0';
  setTimeout(function(){
    if (f.el.parentNode) f.el.parentNode.removeChild(f.el);
    delete floaterMap[id];
    floaterObjs = floaterObjs.filter(function(o){ return o !== f; });
  }, 350);
}

// ── comments ───────────────────────────────────────────────────────────────
async function loadComments(id) {
  try {
    var res  = await fetch('/api/comments/'+id);
    var list = await res.json();
    commentsCache[id] = list;
    renderComments(list);
  } catch(e) {}
}

function renderComments(list) {
  var el = document.getElementById('dcmts');
  if (!list || !list.length) { el.innerHTML = ''; return; }
  el.innerHTML = list.map(function(c){
    return '<div class="cmt-bubble"><span class="cmt-ts">'+fmtTs(c.created_at)+'</span>'+esc(c.text)+'</div>';
  }).join('');
}

async function sendComment() {
  if (!currentId) return;
  var inp  = document.getElementById('dcmt');
  var text = (inp.value||'').trim();
  if (!text) return;
  try {
    var res = await fetch('/api/comments/'+currentId, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({text:text})
    });
    var c = await res.json();
    if (!commentsCache[currentId]) commentsCache[currentId] = [];
    commentsCache[currentId].push(c);
    renderComments(commentsCache[currentId]);
    inp.value = '';
    // Scroll comments to bottom
    var dcmts = document.getElementById('dcmts');
    dcmts.lastElementChild && dcmts.lastElementChild.scrollIntoView({behavior:'smooth'});
  } catch(e) { showToast('Failed to send note'); }
}

// Enter key in comment input
document.getElementById('dcmt').addEventListener('keydown', function(e){
  if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); sendComment(); }
});

// ── data loading ───────────────────────────────────────────────────────────
async function loadItems() {
  try {
    var res1 = await fetch('/api/queue');
    var res2 = await fetch('/api/possible');
    var pending  = await res1.json();
    var possible = await res2.json();
    var all = pending.concat(possible);
    all.forEach(function(item){ buildFloater(item); });
  } catch(e) { console.error('Failed to load items', e); }
}

// ── start ──────────────────────────────────────────────────────────────────
loadItems();
animate();
</script>

<!-- ── ADDITIONS: header + list view (no existing code modified) ────────── -->
<style>
/* overlay z-index raised above header */
#overlay { z-index: 600; }

/* floaters container pushed below header */
#fc { top: 48px; }

/* ── sticky header ── */
#wa-header {
  position: fixed; top: 0; left: 0; right: 0; z-index: 500;
  height: 48px;
  display: flex; align-items: center; padding: 0 20px; gap: 16px;
  background: rgba(28,14,4,0.85);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.wah-title {
  color: #E0D794; font-weight: 800; font-size: .88rem;
  letter-spacing: -.01em; flex-shrink: 0; white-space: nowrap;
}
.wah-center { flex: 1; display: flex; justify-content: center; }
.wah-pill {
  display: flex; padding: 3px; gap: 2px;
  border: 1px solid rgba(255,255,255,0.15); border-radius: 999px;
  background: rgba(0,0,0,0.25);
}
.wah-btn {
  padding: 4px 15px; border: none; border-radius: 999px;
  font-size: .76rem; font-weight: 700; letter-spacing: .02em;
  cursor: pointer; background: transparent;
  color: rgba(255,255,255,0.45);
  transition: background .18s, color .18s;
}
.wah-btn.wah-active { background: #B8AB38; color: #1C0E04; }
.wah-auth {
  font-size: .73rem; color: rgba(255,255,255,0.38);
  flex-shrink: 0; white-space: nowrap;
}
.wah-auth a { color: #B8AB38; text-decoration: none; }
.wah-auth a:hover { text-decoration: underline; }

/* ── list view container ── */
#list-view {
  position: fixed; inset: 0; top: 48px; z-index: 50;
  overflow-y: auto; display: none;
  background: #0f0a05;
  padding-bottom: 48px;
  scrollbar-width: thin; scrollbar-color: #3d2415 transparent;
}
#list-view::-webkit-scrollbar { width: 5px; }
#list-view::-webkit-scrollbar-thumb { background: #3d2415; border-radius: 4px; }
.lv-inner { max-width: 680px; margin: 0 auto; padding: 8px 16px; }

.lv-sec-head {
  display: flex; align-items: center; gap: 9px; margin: 22px 0 12px;
}
.lv-sec-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.lv-sec-label {
  font-size: .68rem; font-weight: 800; letter-spacing: .08em;
  text-transform: uppercase; color: rgba(255,255,255,0.38);
}
.lv-sec-count {
  background: rgba(255,255,255,0.07); color: rgba(255,255,255,0.32);
  border-radius: 999px; padding: 1px 8px; font-size: .68rem; font-weight: 700;
}

/* ── list card ── */
.lv-card {
  border: 2px solid #1a1a1a; border-left-width: 3px;
  border-radius: 20px; overflow: hidden; margin-bottom: 14px;
  transition: transform .15s, box-shadow .15s;
}
.lv-card:hover { transform: translateY(-1px); box-shadow: 0 8px 28px rgba(0,0,0,0.22); }
.lv-candy { height: 6px; }
.lv-head {
  display: flex; align-items: center; gap: 10px;
  padding: 13px 16px 0;
}
.lv-avatar {
  width: 38px; height: 38px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 800; color: #1a1a1a;
  flex-shrink: 0; position: relative; user-select: none;
}
.lv-dot {
  position: absolute; bottom: 0; right: 0;
  width: 11px; height: 11px; border-radius: 50%; border: 2px solid #fff;
}
.lv-identity { flex: 1; min-width: 0; }
.lv-name {
  font-weight: 700; font-size: .87rem; color: #1a1a1a;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.lv-chip {
  display: inline-block; margin-top: 3px;
  font-size: .63rem; font-weight: 800; letter-spacing: .05em;
  text-transform: uppercase; border-radius: 999px; padding: 2px 8px;
}
.lv-chip-event { background: #e0e7ff; color: #3730a3; }
.lv-chip-task  { background: #dcfce7; color: #166534; }
.lv-conf { font-size: .68rem; font-weight: 700; color: rgba(0,0,0,0.3); flex-shrink: 0; }
.lv-title {
  font-size: .95rem; font-weight: 700; color: #1a1a1a; line-height: 1.4;
  outline: none; margin: 10px 16px 10px; cursor: text;
  border-bottom: 1.5px dashed rgba(0,0,0,0.14); padding-bottom: 4px;
}
.lv-title:focus { border-bottom-color: #B8AB38; }
.lv-field { display: flex; flex-direction: column; gap: 4px; margin: 0 16px 10px; }
.lv-lbl {
  font-size: .63rem; font-weight: 800; letter-spacing: .07em;
  text-transform: uppercase; color: rgba(0,0,0,0.3);
}
.lv-textarea, .lv-input {
  width: 100%; padding: 7px 10px;
  border: 1px solid rgba(0,0,0,0.12); border-radius: 8px;
  font-size: .84rem; font-family: inherit;
  background: rgba(255,255,255,0.65); color: #1a1a1a;
  transition: border-color .15s;
}
.lv-textarea { resize: vertical; min-height: 52px; }
.lv-textarea:focus, .lv-input:focus { outline: none; border-color: #B8AB38; }
.lv-dt-row { display: flex; gap: 8px; align-items: flex-end; margin: 0 16px 10px; }
.lv-dt-row .lv-field { margin: 0; flex: 1; }
.lv-btn-save {
  padding: 7px 12px; background: rgba(0,0,0,0.07); color: #1a1a1a;
  border: 1px solid rgba(0,0,0,0.12); border-radius: 8px;
  font-size: .78rem; font-weight: 700; cursor: pointer; height: 34px; white-space: nowrap;
}
.lv-btn-save:hover { background: rgba(0,0,0,0.13); }
.lv-details { margin: 0 16px 10px; }
.lv-summary {
  font-size: .73rem; color: rgba(0,0,0,0.35); cursor: pointer;
  user-select: none; list-style: none; padding: 3px 0;
}
.lv-summary:hover { color: rgba(0,0,0,0.55); }
.lv-summary::before { content: '\25B8  '; font-size: .65rem; }
details[open] > .lv-summary::before { content: '\25BE  '; }
.lv-raw {
  margin-top: 5px; padding: 8px 10px;
  background: rgba(0,0,0,0.05); border: 1px solid rgba(0,0,0,0.08); border-radius: 8px;
  font-size: .69rem; font-family: 'SF Mono','Fira Code',monospace;
  white-space: pre-wrap; max-height: 120px; overflow-y: auto;
  color: rgba(0,0,0,0.45); line-height: 1.5;
}
.lv-notes { margin: 0 16px 10px; }
.lv-notes-lbl {
  font-size: .63rem; font-weight: 800; letter-spacing: .07em;
  text-transform: uppercase; color: rgba(0,0,0,0.3); margin-bottom: 7px;
}
.lv-cmts { display: flex; flex-direction: column; gap: 5px; margin-bottom: 7px; }
.lv-cmt-bubble {
  background: rgba(255,255,255,0.75); border: 1px solid rgba(0,0,0,0.07);
  border-radius: 8px; padding: 6px 10px;
  font-size: .79rem; color: #1a1a1a; line-height: 1.4;
}
.lv-cmt-ts { font-size: .63rem; color: rgba(0,0,0,0.28); margin-right: 5px; }
.lv-cmt-row { display: flex; gap: 7px; }
.lv-cmt-input {
  flex: 1; padding: 7px 10px;
  border: 1px solid rgba(0,0,0,0.12); border-radius: 8px;
  font-size: .79rem; font-family: inherit;
  background: rgba(255,255,255,0.65); color: #1a1a1a;
}
.lv-cmt-input:focus { outline: none; border-color: #B8AB38; }
.lv-btn-send {
  padding: 7px 12px; background: #B8AB38; color: #1a1a1a;
  border: none; border-radius: 8px; font-size: .79rem; font-weight: 800; cursor: pointer;
}
.lv-btn-send:hover { background: #cfc044; }
.lv-actions {
  display: flex; gap: 8px; justify-content: flex-end;
  padding: 10px 16px 14px; border-top: 1px solid rgba(0,0,0,0.07);
}
.lv-btn-dismiss {
  padding: 7px 14px; background: rgba(0,0,0,0.06); color: rgba(0,0,0,0.42);
  border: 1px solid rgba(0,0,0,0.1); border-radius: 8px;
  font-size: .8rem; font-weight: 700; cursor: pointer;
}
.lv-btn-dismiss:hover { background: #fee2e2; color: #991b1b; border-color: #fca5a5; }
.lv-btn-approve {
  padding: 7px 16px; border: none; border-radius: 8px;
  font-size: .8rem; font-weight: 800; cursor: pointer;
}
.lv-btn-approve:hover { filter: brightness(1.08); }
@keyframes lvSlideOut {
  to { opacity:0; transform:translateX(50px); max-height:0; margin-bottom:0; padding:0; overflow:hidden; }
}
.lv-card.lv-removing { animation: lvSlideOut 0.28s ease-in forwards; pointer-events: none; }
</style>

<!-- header -->
<div id="wa-header">
  <span class="wah-title">WhatsApp Agent</span>
  <div class="wah-center">
    <div class="wah-pill">
      <button id="btn-workspace" class="wah-btn wah-active" onclick="switchView('workspace')">Workspace</button>
      <button id="btn-list"      class="wah-btn"            onclick="switchView('list')">List</button>
    </div>
  </div>
  <div class="wah-auth">Google: <a href="/auth">Connect</a></div>
</div>

<!-- list view -->
<div id="list-view">
  <div class="lv-inner">
    <div class="lv-sec-head">
      <span class="lv-sec-dot" style="background:#7F77DD"></span>
      <span class="lv-sec-label">Pending review</span>
      <span class="lv-sec-count" id="lv-cnt-pending">0</span>
    </div>
    <div id="lv-pending"></div>
    <div class="lv-sec-head">
      <span class="lv-sec-dot" style="background:#EF9F27"></span>
      <span class="lv-sec-label">Possible</span>
      <span class="lv-sec-count" id="lv-cnt-possible">0</span>
    </div>
    <div id="lv-possible"></div>
  </div>
</div>

<script>
// ── list view ──────────────────────────────────────────────────────────────
function lvCard(item) {
  var ip  = item.status === 'possible';
  var bc  = ip ? '#EF9F27' : '#7F77DD';
  var bg  = ip ? '#FFF8ED' : '#F0EDFF';
  var sc1 = ip ? 'rgba(239,159,39,0.22)' : 'rgba(127,119,221,0.22)';
  var sc2 = ip ? 'rgba(239,159,39,0.06)' : 'rgba(127,119,221,0.06)';
  var dc  = item.type === 'event' ? '#7F77DD' : '#22c55e';
  var cf  = item.confidence != null ? Math.round(item.confidence*100)+'%' : (ip ? '40-69%' : '70%+');
  var abg = item.type === 'event' ? '#B8AB38' : '#9FE1CB';
  var al  = item.type === 'event' ? 'Add to Calendar' : 'Add to Tasks';
  var cc  = item.type === 'event' ? 'lv-chip lv-chip-event' : 'lv-chip lv-chip-task';
  var cl  = item.type === 'event' ? 'Event' : 'Task';
  var av  = getInitials(item.chat_name);
  var avb = avatarColor(item.chat_name);
  var id  = item.id;
  return '<div class="lv-card" id="lv-card-'+id+'" style="border-left-color:'+bc+';background:'+bg+'">'
    +'<div class="lv-candy" style="background:repeating-linear-gradient(90deg,'+sc1+' 0,'+sc1+' 8px,'+sc2+' 8px,'+sc2+' 16px)"></div>'
    +'<div class="lv-head">'
      +'<div class="lv-avatar" style="background:'+avb+'">'+av+'<span class="lv-dot" style="background:'+dc+'"></span></div>'
      +'<div class="lv-identity"><div class="lv-name">'+esc(item.chat_name||'')+'</div><span class="'+cc+'">'+cl+'</span></div>'
      +'<span class="lv-conf">'+cf+'</span>'
    +'</div>'
    +'<div class="lv-title" contenteditable="true" id="lv-t-'+id+'">'+esc(item.title)+'</div>'
    +'<div class="lv-field"><label class="lv-lbl">Description</label>'
      +'<textarea class="lv-textarea" id="lv-d-'+id+'">'+esc(item.description||'')+'</textarea></div>'
    +'<div class="lv-dt-row"><div class="lv-field"><label class="lv-lbl">Date &amp; Time</label>'
      +'<input type="datetime-local" class="lv-input" id="lv-dt-'+id+'" value="'+toLocalInput(item.datetime)+'"></div>'
      +'<button class="lv-btn-save" onclick="lvSave('+id+')">Save</button></div>'
    +'<details class="lv-details"><summary class="lv-summary">Chat context</summary>'
      +'<div class="lv-raw">'+esc(item.raw_messages||'')+'</div></details>'
    +'<div class="lv-notes"><div class="lv-notes-lbl">Notes</div>'
      +'<div class="lv-cmts" id="lv-c-'+id+'"></div>'
      +'<div class="lv-cmt-row">'
        +'<input type="text" class="lv-cmt-input" id="lv-ci-'+id+'" data-qid="'+id+'" placeholder="Add a note\u2026">'
        +'<button class="lv-btn-send" onclick="lvSendCmt('+id+')">Send</button>'
      +'</div></div>'
    +'<div class="lv-actions">'
      +'<button class="lv-btn-dismiss" onclick="lvDismiss('+id+')">Dismiss</button>'
      +'<button class="lv-btn-approve" style="background:'+abg+';color:#1a1a1a" onclick="lvApprove('+id+')">'+al+'</button>'
    +'</div>'
  +'</div>';
}

function lvRender(listId, cntId, items) {
  document.getElementById(cntId).textContent = items.length;
  var el = document.getElementById(listId);
  if (!items.length) { el.innerHTML = '<p style="color:rgba(255,255,255,0.18);font-size:.84rem;padding:4px 0">No items.</p>'; return; }
  el.innerHTML = items.map(lvCard).join('');
  items.forEach(function(item){ lvFetchCmts(item.id); });
}

async function lvLoad() {
  try {
    var r1 = await fetch('/api/queue');
    var r2 = await fetch('/api/possible');
    lvRender('lv-pending',  'lv-cnt-pending',  await r1.json());
    lvRender('lv-possible', 'lv-cnt-possible', await r2.json());
  } catch(e) { console.error('lvLoad', e); }
}

async function lvFetchCmts(id) {
  try {
    var list = await fetch('/api/comments/'+id).then(function(r){return r.json();});
    var el = document.getElementById('lv-c-'+id);
    if (!el) return;
    el.innerHTML = list.map(function(c){
      return '<div class="lv-cmt-bubble"><span class="lv-cmt-ts">'+fmtTs(c.created_at)+'</span>'+esc(c.text)+'</div>';
    }).join('');
  } catch(e) {}
}

async function lvSave(id) {
  var t  = (document.getElementById('lv-t-'+id)||{}).textContent||'';
  var d  = (document.getElementById('lv-d-'+id)||{}).value||'';
  var dv = (document.getElementById('lv-dt-'+id)||{}).value||'';
  try {
    await fetch('/api/item/'+id, {method:'PATCH',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({title:t.trim(),description:d.trim(),datetime:dv?new Date(dv).toISOString():null})});
    showToast('Saved.');
  } catch(e) { showToast('Save failed.'); }
}

async function lvApprove(id) {
  var t  = (document.getElementById('lv-t-'+id)||{}).textContent||'';
  var d  = (document.getElementById('lv-d-'+id)||{}).value||'';
  var dv = (document.getElementById('lv-dt-'+id)||{}).value||'';
  try {
    var res = await fetch('/api/approve/'+id, {method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({title:t.trim(),description:d.trim(),datetime:dv?new Date(dv).toISOString():null})});
    var data = await res.json();
    if (data.error) { showToast('Error: '+data.error); return; }
    showToast('Added to Google!');
    lvRemove(id);
  } catch(e) { showToast('Network error'); }
}

async function lvDismiss(id) {
  try {
    await fetch('/api/reject/'+id, {method:'POST'});
    showToast('Dismissed.');
    lvRemove(id);
  } catch(e) { showToast('Network error'); }
}

function lvRemove(id) {
  var el = document.getElementById('lv-card-'+id);
  if (!el) return;
  el.classList.add('lv-removing');
  setTimeout(function(){ if (el.parentNode) el.parentNode.removeChild(el); }, 300);
}

async function lvSendCmt(id) {
  var inp = document.getElementById('lv-ci-'+id);
  var txt = inp ? inp.value.trim() : '';
  if (!txt) return;
  try {
    await fetch('/api/comments/'+id, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:txt})});
    inp.value = '';
    lvFetchCmts(id);
  } catch(e) { showToast('Failed to send note'); }
}

document.getElementById('list-view').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey && e.target.classList.contains('lv-cmt-input')) {
    e.preventDefault();
    var qid = e.target.getAttribute('data-qid');
    if (qid) lvSendCmt(Number(qid));
  }
});

// ── view switcher ──────────────────────────────────────────────────────────
function switchView(v) {
  var fcEl = document.getElementById('fc');
  var bgEl = document.getElementById('bg');
  var lvEl = document.getElementById('list-view');
  var btnW = document.getElementById('btn-workspace');
  var btnL = document.getElementById('btn-list');
  if (v === 'workspace') {
    fcEl.style.opacity = '1';  fcEl.style.pointerEvents = 'auto';
    bgEl.style.display = 'block';
    lvEl.style.display = 'none';
    btnW.classList.add('wah-active'); btnL.classList.remove('wah-active');
  } else {
    fcEl.style.opacity = '0';  fcEl.style.pointerEvents = 'none';
    bgEl.style.display = 'none';
    lvEl.style.display = 'block';
    btnW.classList.remove('wah-active'); btnL.classList.add('wah-active');
    lvLoad();
  }
  try { localStorage.setItem('wa-view', v); } catch(e) {}
}

(function() {
  try { var s = localStorage.getItem('wa-view'); if (s === 'list') switchView('list'); } catch(e) {}
})();
</script>
</body>
</html>`;
}

app.get('/', (req, res) => res.send(getHTML()));

const PORT = 3000;
app.listen(PORT, () => console.log('Review server running at http://localhost:' + PORT));
