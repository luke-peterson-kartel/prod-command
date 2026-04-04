/**
 * PROD Command — AirTable Live Sync Server
 * Polls AirTable every 60s, serves /api/board-data
 * Google OAuth 2.0 — restricts access to @kartel.ai accounts
 */

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const { exec } = require('child_process');

const AT_KEY = process.env.AIRTABLE_KEY ||
  (() => { try { return fs.readFileSync(process.env.HOME + '/.config/airtable/api_key', 'utf8').trim(); } catch(e) { return ''; } })();
const BASE_ID           = 'appRBFRW3pZ7rUDFh';
const TABLE_ID          = 'tblCrQJIBuXscN4tq';
const VIEW_ID           = 'viwAAn6Xd4o6yw1Tc';
const MILESTONES_TABLE  = 'tblN6kEQxeiNJtBDR';
const PORT = process.env.PORT || 7341;

// ── Google OAuth config ────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const BASE_URL             = process.env.BASE_URL || `http://localhost:${PORT}`;
const ALLOWED_DOMAIN       = 'kartel.ai';
const AUTH_ENABLED         = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
const SESSION_TTL_MS       = 8 * 60 * 60 * 1000; // 8 hours

// ── Session store (in-memory) ──────────────────────────────────
const sessions   = new Map(); // sessionId → { email, name, expires }
const oauthState = new Map(); // state → { created }

function genToken() { return crypto.randomBytes(32).toString('hex'); }

function getSession(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/prod_session=([a-f0-9]{64})/);
  if (!m) return null;
  const sess = sessions.get(m[1]);
  if (!sess) return null;
  if (Date.now() > sess.expires) { sessions.delete(m[1]); return null; }
  return { ...sess, id: m[1] };
}

function setSessionCookie(res, sessionId) {
  const secure = BASE_URL.startsWith('https') ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `prod_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'prod_session=; Path=/; HttpOnly; Max-Age=0');
}

// ── Google OAuth helpers ───────────────────────────────────────
function googleAuthUrl(state) {
  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  `${BASE_URL}/auth/google/callback`,
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'online',
    state,
    hd:            ALLOWED_DOMAIN, // hint: only show kartel.ai accounts
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCode(code) {
  const postData = new URLSearchParams({
    code,
    client_id:     GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri:  `${BASE_URL}/auth/google/callback`,
    grant_type:    'authorization_code',
  }).toString();

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function getUserInfo(accessToken) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'www.googleapis.com',
      path: '/oauth2/v2/userinfo',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

// ── Login page ─────────────────────────────────────────────────
function loginPage(error = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PROD Command — Sign In</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0e1a; display: flex; align-items: center; justify-content: center; min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  .card { background: #111827; border: 1px solid #1e2a3a; border-radius: 16px; padding: 48px 40px; text-align: center; max-width: 380px; width: 90%; }
  .logo { font-size: 32px; margin-bottom: 8px; }
  .title { font-size: 20px; font-weight: 700; color: #f0f4ff; margin-bottom: 4px; letter-spacing: 0.05em; }
  .sub { font-size: 12px; color: #4a6080; margin-bottom: 32px; }
  .btn { display: inline-flex; align-items: center; gap: 12px; background: #fff; color: #1a1a1a; font-size: 14px; font-weight: 600; padding: 12px 24px; border-radius: 8px; text-decoration: none; border: none; cursor: pointer; transition: opacity 0.15s; }
  .btn:hover { opacity: 0.9; }
  .btn-icon { width: 20px; height: 20px; }
  .error { margin-top: 20px; font-size: 12px; color: #ef4444; background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.2); border-radius: 6px; padding: 8px 12px; }
  .domain { margin-top: 16px; font-size: 11px; color: #2a4060; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">🟢</div>
  <div class="title">KARTEL | PRODUCTION COMMAND</div>
  <div class="sub">Internal use only</div>
  <a href="/auth/google" class="btn">
    <svg class="btn-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
    Sign in with Google
  </a>
  ${error ? `<div class="error">${error}</div>` : ''}
  <div class="domain">@kartel.ai accounts only</div>
</div>
</body>
</html>`;
}

// ── AirTable columns ───────────────────────────────────────────
const COLUMNS = [
  'Creative Brief', 'LookDev', 'Storyboard', 'Animatic',
  'Rough Cut', 'Fine Cut', 'Final Delivery'
];

// ── Lookup tables ──────────────────────────────────────────────
let teamMembers = {};
let clients = {};
let artists = {};
let cachedArtistData     = null;
let cachedBoardData      = null;
let cachedMilestonesData = null;
let lastFetch            = 0;
let milestonesLastFetch  = 0;
const MILESTONES_TTL_MS  = 2 * 60 * 1000; // 2-min cache

// ── Recent moves tracker ───────────────────────────────────────
const MOVES_FILE = path.join(__dirname, 'recent-moves.json');
const MOVES_TTL_MS = 14 * 24 * 60 * 60 * 1000; // keep 14 days
const MOVE_COLORS = {
  'Complete':       '#818cf8',
  'Final Delivery': '#f59e0b',
  'Fine Cut':       '#00ff88',
  'Rough Cut':      '#00ff88',
  'Animatic':       '#00ff88',
  'Storyboard':     '#00d4ff',
  'LookDev':        '#00d4ff',
  'Creative Brief': '#f59e0b',
};

let recentMoves = [];
let prevPlacement = {}; // cardId → { col, name }
let isFirstPoll = true;

// ── Project Overview (Google Sheet) ───────────────────────────
const OVERVIEW_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1wKobLrHuL6SXcyW8Xo-rQLBnQklSh-9d_Ega5cmZhzc/gviz/tq?tqx=out:csv&sheet=PROJECT+OVERVIEW';
let cachedOverviewData = null;
let overviewLastFetch = 0;
const OVERVIEW_TTL_MS = 5 * 60 * 1000; // 5 minutes

function fetchOverviewData() {
  return new Promise((resolve, reject) => {
    https.get(OVERVIEW_SHEET_URL, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, res2 => {
          let data = '';
          res2.on('data', c => data += c);
          res2.on('end', () => resolve(parseOverviewCSV(data)));
        }).on('error', reject);
        return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(parseOverviewCSV(data)));
    }).on('error', reject);
  });
}

function parseOverviewCSV(csv) {
  const lines = csv.split('\n').map(l => l.trim()).filter(Boolean);
  const projects = [];
  let headerRowIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('PROJECTS') && lines[i].includes('PRODUCER')) { headerRowIndex = i; break; }
  }
  if (headerRowIndex === -1) return { projects, fetchedAt: new Date().toISOString() };
  for (let i = headerRowIndex + 1; i < lines.length; i++) {
    const cols = parseCSVRow(lines[i]);
    if (!cols[0] || cols[0].startsWith('"') === false && cols[0] === '') continue;
    const name = cols[0] || '';
    if (!name) continue;
    projects.push({
      name,
      producer:        cols[1] || '',
      artist1:         cols[2] || '',
      artist2:         cols[3] || '',
      artist3:         cols[4] || '',
      editor:          cols[5] || '',
      motionGraphics:  cols[6] || '',
      output:          cols[7] || '',
      budget:          cols[8] || '',
      status:          cols[9] || '',
    });
  }
  return { projects, fetchedAt: new Date().toISOString() };
}

function parseCSVRow(line) {
  const result = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; continue; }
    if (ch === ',' && !inQuote) { result.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  result.push(cur.trim());
  return result;
}

async function refreshOverviewIfNeeded() {
  if (Date.now() - overviewLastFetch < OVERVIEW_TTL_MS && cachedOverviewData) return;
  try {
    cachedOverviewData = await fetchOverviewData();
    overviewLastFetch = Date.now();
    console.log(`[OVERVIEW] Fetched ${cachedOverviewData.projects.length} projects from sheet`);
  } catch(e) {
    console.error('[OVERVIEW] Fetch error:', e.message);
  }
}

function loadMoves() {
  try {
    const raw = JSON.parse(fs.readFileSync(MOVES_FILE, 'utf8'));
    recentMoves = Array.isArray(raw) ? raw : [];
    console.log(`[MOVES] Loaded ${recentMoves.length} recent moves from disk`);
  } catch(e) {
    // Pre-seed with known transitions so ticker isn't blank on first deploy
    recentMoves = [
      { name:'Newell - Outdoor Brands', from:'Final Delivery', to:'Complete',       date:'Mar 13', color:'#818cf8', ts: Date.now() },
      { name:'NEB - Peptides "The Wolverine Stack"', from:'Final Delivery', to:'Complete', date:'Mar 13', color:'#818cf8', ts: Date.now() - 3600000 },
      { name:'Kartel Real Estate Reel', from:'Fine Cut',       to:'Complete',       date:'Mar 11', color:'#818cf8', ts: Date.now() - 172800000 },
      { name:'LIDL (2025-152)',          from:'Final Delivery', to:'Complete',       date:'Mar 11', color:'#818cf8', ts: Date.now() - 172800000 },
      { name:'GoGo Running',             from:'Storyboard',     to:'Animatic',       date:'Mar 11', color:'#00ff88', ts: Date.now() - 172800000 },
      { name:'GoGo Soccer',              from:'Storyboard',     to:'Creative Brief', date:'Mar 10', color:'#f59e0b', ts: Date.now() - 259200000 },
      { name:'NEB Academy',              from:'Pre-Production', to:'Rough Cut',      date:'Mar 11', color:'#00ff88', ts: Date.now() - 172800000 },
      { name:'Newell Outdoor',           from:'Post-Production','to':'Final Delivery',date:'Mar 10',color:'#f59e0b', ts: Date.now() - 259200000 },
    ];
    saveMoves();
  }
}

function saveMoves() {
  try { fs.writeFileSync(MOVES_FILE, JSON.stringify(recentMoves), 'utf8'); } catch(e) {}
}

function trackMoves(columns, complete) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  // Build current placement map
  const current = {};
  for (const [col, cards] of Object.entries(columns)) {
    for (const card of cards) current[card.id] = { col, name: card.name };
  }
  for (const card of complete) current[card.id] = { col: 'Complete', name: card.name };

  if (!isFirstPoll) {
    for (const [id, cur] of Object.entries(current)) {
      const prev = prevPlacement[id];
      if (prev && prev.col !== cur.col) {
        const color = MOVE_COLORS[cur.col] || '#7a9bb5';
        recentMoves.unshift({ name: cur.name, from: prev.col, to: cur.col, date: dateStr, color, ts: now.getTime() });
        console.log(`[MOVES] ${cur.name}: ${prev.col} → ${cur.col}`);
      }
    }
    // Prune old entries
    const cutoff = now.getTime() - MOVES_TTL_MS;
    recentMoves = recentMoves.filter(m => m.ts >= cutoff).slice(0, 30);
    saveMoves();
  }

  prevPlacement = current;
  isFirstPoll = false;
}

const PRODUCER_COLORS = {
  'Veronica Diaz':        { bg: '#0e7c5a', fg: '#00ff88' },
  'Monica Monique':       { bg: '#5c1a6e', fg: '#d46cff' },
  'Seb Webber':           { bg: '#1a3a5c', fg: '#00d4ff' },
  'Stuart Acher':         { bg: '#3a2a0e', fg: '#f59e0b' },
  'Wayan Palmieri':       { bg: '#0e7c5a', fg: '#00ff88' },
  'Estefania Guarderas':  { bg: '#1a3a5c', fg: '#00d4ff' },
  'Rebecca Cook':         { bg: '#2a1a5c', fg: '#818cf8' },
};

function initials(name) { return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase(); }
function colorFor(name) { return PRODUCER_COLORS[name] || { bg: '#1a2a3a', fg: '#7a9bb5' }; }

// ── AirTable fetch ─────────────────────────────────────────────
function atFetch(urlPath) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'api.airtable.com', path: urlPath, headers: { 'Authorization': `Bearer ${AT_KEY}` } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function fetchAllRecords(tableName, params = '') {
  let records = [], offset = null;
  do {
    const qs = new URLSearchParams();
    if (offset) qs.set('offset', offset);
    if (params) { const extra = new URLSearchParams(params); for (const [k,v] of extra) qs.set(k,v); }
    const data = await atFetch(`/v0/${BASE_ID}/${encodeURIComponent(tableName)}?${qs}`);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}

async function loadLookups() {
  const [teamRecs, clientRecs, artistRecs] = await Promise.all([
    fetchAllRecords('Team Members'),
    fetchAllRecords('Clients'),
    fetchAllRecords('Artists'),
  ]);
  teamRecs.forEach(r => { const name = r.fields['Full Name'] || '?'; teamMembers[r.id] = { name, initials: initials(name), ...colorFor(name) }; });
  clientRecs.forEach(r => { clients[r.id] = r.fields['Company Name'] || '?'; });
  artistRecs.forEach(r => {
    const name = r.fields['Artist Name'] || '?';
    artists[r.id] = { name, role: r.fields['Artist Role'] || 'Artist', code: r.fields['Code'] || initials(name) };
  });
  console.log(`[INIT] Loaded ${Object.keys(teamMembers).length} team members, ${Object.keys(clients).length} clients, ${Object.keys(artists).length} artists`);
}

// ── SLA helpers ───────────────────────────────────────────────
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  return Math.round((new Date(dateStr + 'T00:00:00') - today) / 86400000);
}
function slaBadge(days) {
  if (days === null) return { label: '—', cls: '' };
  if (days < 0)  return { label: `${Math.abs(days)}d OVR`, cls: 'overdue' };
  if (days === 0) return { label: 'TODAY', cls: 'today' };
  if (days <= 3)  return { label: `${days} days`, cls: 'at-risk' };
  return { label: `${days} days`, cls: 'on-track' };
}
function cardStatus(days) {
  if (days === null) return '';
  if (days < 0) return 'overdue';
  if (days <= 3) return 'at-risk';
  return '';
}
function scrumFirst(note) {
  if (!note) return '';
  return (note.trim().split('\n').find(l => l.trim()) || '').replace(/^\d+\/\d+\s*[-–]\s*/, '').trim().slice(0, 120);
}
function scrumDate(note) {
  if (!note) return '';
  const m = note.trim().match(/^(\d+\/\d+)/);
  return m ? m[1] : '';
}

// ── Build board data ───────────────────────────────────────────
async function buildBoardData() {
  const records = await fetchAllRecords(TABLE_ID, `view=${VIEW_ID}`);
  const columns = {}; COLUMNS.forEach(c => columns[c] = []);
  const bench = [], complete = [];

  for (const r of records) {
    const f = r.fields;
    const prodStatus = f['Prod Status'];
    const status = f['Project Status'] || f['Status'] || '';
    const producerRec = (f['Producer'] || [])[0] ? teamMembers[(f['Producer'] || [])[0]] : null;
    const companyIds = f['Company'] || [];
    let clientName = companyIds[0] ? clients[companyIds[0]] : '';
    if (!clientName) {
      const parts = (f['Project Name'] || '').split(/\s*[-–]\s*/);
      clientName = parts.length > 1 ? parts[0].trim() : (f['Project Name'] || '');
    }
    const slaDate = f['Final Delivery Due Date (SOW)'] || null;
    const days = daysUntil(slaDate);
    const badge = slaBadge(days);
    const cardCls = cardStatus(days);
    const scrum = f['SCRUM Status Note'] || '';
    const artistList = (f['Artist(s)'] || []).map(aid => artists[aid]).filter(Boolean);

    const card = {
      id: r.id,
      name: f['Project Name'] || 'Untitled',
      jobId: f['Project ID'] || '',
      client: clientName,
      producer: producerRec,
      slaDate, slaDays: days, slaBadge: badge, cardClass: cardCls,
      scrumNote: scrumFirst(scrum), scrumDate: scrumDate(scrum),
      projectType: Array.isArray(f['Project Type']) ? f['Project Type'][0] : (f['Project Type'] || ''),
      invoiceStatus: f['Invoice Status'] || '',
      finalDelivery: f['Final Delivery (Actual)'] || null,
      driveLink: f['Data Link'] || null,
      artists: artistList,
      prodStatus: prodStatus || '',
      projectStatus: status || '',
      budget: f['Budget'] || '',
      deliverables: f['Deliverable(s)'] || '',
    };

    if (!prodStatus || prodStatus === '') {
      if (status === 'Complete')       complete.push({ ...card, slaBadge: { label: 'DONE', cls: 'done' } });
      else if (status === 'ON HOLD')   bench.push({ ...card, benchStatus: 'ON HOLD' });
      else if (status === 'On Deck')   bench.push({ ...card, benchStatus: 'ON DECK' });
    } else if (prodStatus === 'N/A') {
      bench.push({ ...card, benchStatus: status === 'ON HOLD' ? 'ON HOLD' : 'ON DECK' });
    } else if (prodStatus === 'Complete') {
      complete.push({ ...card, slaBadge: { label: 'DONE', cls: 'done' } });
    } else if (COLUMNS.includes(prodStatus)) {
      columns[prodStatus].push(card);
    }
  }

  // Sort complete: most recent first (finalDelivery date, fall back to slaDate)
  complete.sort((a, b) => {
    const da = a.finalDelivery || a.slaDate || '';
    const db = b.finalDelivery || b.slaDate || '';
    return db.localeCompare(da);
  });

  // Track column transitions
  trackMoves(columns, complete);

  const allActive = Object.values(columns).flat();
  return {
    fetchedAt: new Date().toISOString(),
    recentMoves: [...recentMoves],
    stats: {
      activeEngagements: allActive.length,
      onTrack:  allActive.filter(c => !c.cardClass || c.cardClass === 'on-track').length,
      atRisk:   allActive.filter(c => c.cardClass === 'at-risk').length,
      overdue:  allActive.filter(c => c.cardClass === 'overdue').length,
      benchCount:    bench.length,
      completeCount: complete.length,
    },
    columns, bench, complete,
  };
}

// ── Meetings: calendar poll ────────────────────────────────────
const MEETING_CALENDARS = [
  'wayan@kartel.ai',
  'veronica@kartel.ai',
  'monica@kartel.ai',
  'brandon@kartel.ai',
  'estefania@kartel.ai',
];
const KARTEL_DOMAIN = 'kartel.ai';
let cachedMeetings = [];
let meetingsLastFetch = 0;

function execAsync(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 15000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      try { resolve(JSON.parse(stdout)); } catch(e) { resolve(null); }
    });
  });
}

function isClientMeeting(evt) {
  if (!evt || evt.status === 'cancelled') return false;
  // Skip all-day events
  if (evt.start && evt.start.date && !evt.start.dateTime) return false;
  const attendees = evt.attendees || [];
  // Must have at least one external (non-kartel.ai) attendee
  const hasExternal = attendees.some(a => a.email && !a.email.endsWith('@' + KARTEL_DOMAIN) && !a.email.includes('resource.calendar.google.com'));
  if (!hasExternal) return false;
  // At least one kartel.ai attendee must not have declined
  const kartelAttending = attendees.filter(a => a.email && a.email.endsWith('@' + KARTEL_DOMAIN) && a.responseStatus !== 'declined');
  if (kartelAttending.length === 0) return false;
  return true;
}

async function pollMeetings() {
  try {
    const seen = new Set();
    const results = [];
    const now = new Date();
    const startOfToday = new Date(now); startOfToday.setHours(0,0,0,0);

    await Promise.all(MEETING_CALENDARS.map(async (cal) => {
      const data = await execAsync(`gog cal list ${cal} --days 14 -j 2>/dev/null`);
      if (!data || !Array.isArray(data.events)) return;
      for (const evt of data.events) {
        if (!evt.id || seen.has(evt.id)) continue;
        if (!isClientMeeting(evt)) continue;
        const startDt = evt.start && (evt.start.dateTime || evt.start.date);
        if (!startDt || new Date(startDt) < startOfToday) continue;
        seen.add(evt.id);
        const attendees = evt.attendees || [];
        const kartelPeople = attendees
          .filter(a => a.email && a.email.endsWith('@' + KARTEL_DOMAIN) && a.responseStatus !== 'declined')
          .map(a => a.email.split('@')[0]);
        const externalPeople = attendees
          .filter(a => a.email && !a.email.endsWith('@' + KARTEL_DOMAIN) && !a.email.includes('resource.calendar.google.com') && a.responseStatus !== 'declined')
          .map(a => {
            if (a.displayName) return a.displayName;
            // Convert email to readable name: "radhika.viswanath@jiostar.com" → "Radhika Viswanath"
            const local = a.email.split('@')[0];
            return local.split(/[._-]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
          });
        results.push({
          id: evt.id,
          title: evt.summary || '(No title)',
          start: startDt,
          end: evt.end && (evt.end.dateTime || evt.end.date),
          location: evt.location || null,
          kartelAttendees: kartelPeople,
          externalAttendees: externalPeople,
          organizer: evt.organizer ? (evt.organizer.displayName || evt.organizer.email) : null,
          link: evt.htmlLink || null,
          past: new Date(startDt) < now,
        });
      }
    }));

    results.sort((a, b) => new Date(a.start) - new Date(b.start));
    cachedMeetings = results;
    meetingsLastFetch = Date.now();
    console.log(`[MEETINGS] ✓ ${results.length} upcoming client meetings found`);
  } catch(e) {
    console.error('[MEETINGS] Error:', e.message);
  }
  setTimeout(pollMeetings, 5 * 60 * 1000); // refresh every 5 min
}

// ── Artist capacity builder ────────────────────────────────────
// Column logic: driven by "Availability Status" field (manually set in AirTable).
// Null/missing → derive from project count. Values: OOO, At Capacity, Almost Full,
// In the Multiverse (treated as Active), or blank (Available/Active by count).
async function buildArtistData() {
  const records = await fetchAllRecords('Artists');
  const EXCLUDED = ['Rebecca Cook', 'Daniel Strange', 'Jason Goldwatch'];

  // Canonical status values for column placement
  const STATUS = {
    AVAILABLE : 'Available',
    ACTIVE    : 'Active',
    ALMOST    : 'Almost Full',
    FULL      : 'At Capacity',
    OOO       : 'OOO',
  };
  const capOrder = {
    [STATUS.FULL]     : 0,
    [STATUS.ALMOST]   : 1,
    [STATUS.ACTIVE]   : 2,
    [STATUS.OOO]      : 3,
    [STATUS.AVAILABLE]: 4,
  };

  const list = records
    .map(r => {
      const f = r.fields;
      const name = f['Artist Name'] || '?';
      if (EXCLUDED.includes(name)) return null;

      const availRaw = (f['Availability Status'] || '').trim(); // manual field
      const count    = typeof f['Project Count'] === 'number' ? f['Project Count'] : 0;
      const max      = typeof f['Max Capacity']  === 'number' ? f['Max Capacity']  : 3;
      const projectNames = Array.isArray(f['Active Projects']) ? f['Active Projects'] : [];

      // Derive canonical status
      let status;
      if (availRaw === 'OOO') {
        status = STATUS.OOO;
      } else if (availRaw === 'At Capacity') {
        status = STATUS.FULL;
      } else if (availRaw === 'Almost Full') {
        status = STATUS.ALMOST;
      } else if (availRaw === 'In the Multiverse') {
        status = STATUS.ACTIVE; // working, but outside main project tracking
      } else {
        // Fall back to count-based logic
        if (max > 0 && count >= max)            status = STATUS.FULL;
        else if (max > 0 && count >= max * 0.6) status = STATUS.ALMOST;
        else if (count > 0)                     status = STATUS.ACTIVE;
        else                                    status = STATUS.AVAILABLE;
      }

      return {
        id: r.id,
        name,
        code:        f['Code']        || name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,3),
        role:        f['Artist Role'] || 'Other',
        recommended: f['Recommended?'] === true || f['Recommended?'] === 1,
        availRaw,   // raw AirTable value for display
        status,
        count,
        max,
        pct: max > 0 ? Math.round((count / max) * 100) : 0,
        projects: projectNames,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (capOrder[a.status] ?? 5) - (capOrder[b.status] ?? 5) || a.name.localeCompare(b.name));

  const stats = {
    total:      list.length,
    available:  list.filter(a => a.status === STATUS.AVAILABLE).length,
    active:     list.filter(a => a.status === STATUS.ACTIVE).length,
    almostFull: list.filter(a => a.status === STATUS.ALMOST).length,
    atCapacity: list.filter(a => a.status === STATUS.FULL).length,
    ooo:        list.filter(a => a.status === STATUS.OOO).length,
    roles:      [...new Set(list.map(a => a.role))].sort(),
  };

  return { artists: list, stats, fetchedAt: new Date().toISOString() };
}

// ── Poll loop ──────────────────────────────────────────────────
async function poll() {
  try {
    console.log('[POLL] Fetching AirTable data...');
    cachedBoardData = await buildBoardData();
    cachedArtistData = await buildArtistData();
    lastFetch = Date.now();
    console.log(`[POLL] ✓ ${cachedBoardData.stats.activeEngagements} active, ${cachedBoardData.stats.benchCount} bench, ${cachedBoardData.stats.completeCount} complete | ${cachedArtistData.stats.available} artists available`);
  } catch(e) {
    console.error('[POLL] Error:', e.message);
  }
  setTimeout(poll, 60_000);
}

// ── Milestones data ────────────────────────────────────────────
async function buildMilestonesData() {
  const [milestoneRecs, projectRecs] = await Promise.all([
    fetchAllRecords(MILESTONES_TABLE),
    fetchAllRecords(TABLE_ID),           // fetch all fields so Project Name + Job ID are available
  ]);

  const projNames = {}, projJobs = {};
  projectRecs.forEach(r => {
    projNames[r.id] = r.fields['Project Name'] || r.fields['Name'] || '?';
    projJobs[r.id]  = r.fields['Job ID'] || '';
  });

  const milestones = milestoneRecs.map(r => {
    const f = r.fields;
    const projectId = (f['Project'] || [])[0] || null;
    const attendeeIds = f['Internal Attendees'] || [];
    const attendeeNames = attendeeIds.map(id => teamMembers[id]?.name || id).filter(Boolean);
    return {
      id:                r.id,
      name:              f['Name'] || f['Milestone Name'] || f['Phase'] || 'Untitled',
      projectId,
      projectName:       projectId ? (projNames[projectId] || 'Unknown') : 'Unknown',
      projectJob:        projectId ? (projJobs[projectId] || '') : '',
      phase:             f['Phase'] || '',
      startDate:         f['Start Date'] || null,
      dueDate:           f['Due Date'] || null,
      status:            f['Status'] || 'Not Started',
      internalAttendees: attendeeNames,
      clientContacts:    f['Client Contacts'] || '',
    };
  });

  // Sort: by projectName, then dueDate
  milestones.sort((a, b) => {
    const pc = a.projectName.localeCompare(b.projectName);
    if (pc !== 0) return pc;
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    return 0;
  });

  return { milestones, fetchedAt: new Date().toISOString() };
}

// ── HTTP server ────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', AUTH_ENABLED ? BASE_URL : '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('ngrok-skip-browser-warning', '1');

  // ── Auth routes ──────────────────────────────────────────────
  if (url.pathname === '/auth/google') {
    if (!AUTH_ENABLED) { res.writeHead(302, { Location: '/' }); res.end(); return; }
    const state = genToken();
    oauthState.set(state, { created: Date.now() });
    setTimeout(() => oauthState.delete(state), 5 * 60 * 1000); // expire in 5min
    res.writeHead(302, { Location: googleAuthUrl(state) });
    res.end();
    return;
  }

  if (url.pathname === '/auth/google/callback') {
    if (!AUTH_ENABLED) { res.writeHead(302, { Location: '/' }); res.end(); return; }
    const code  = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const errParam = url.searchParams.get('error');

    if (errParam || !code || !state || !oauthState.has(state)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(loginPage('Sign-in was cancelled or timed out. Please try again.'));
      return;
    }
    oauthState.delete(state);

    try {
      const tokens   = await exchangeCode(code);
      const userInfo = await getUserInfo(tokens.access_token);
      const email    = userInfo.email || '';

      if (!email.endsWith(`@${ALLOWED_DOMAIN}`)) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(loginPage(`Access denied. Only @${ALLOWED_DOMAIN} accounts are permitted.`));
        return;
      }

      const sessionId = genToken();
      sessions.set(sessionId, { email, name: userInfo.name || email, expires: Date.now() + SESSION_TTL_MS });
      setSessionCookie(res, sessionId);
      console.log(`[AUTH] ✅ ${email} signed in`);
      res.writeHead(302, { Location: '/' });
      res.end();
    } catch(e) {
      console.error('[AUTH] OAuth error:', e.message);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(loginPage('Authentication failed. Please try again.'));
    }
    return;
  }

  if (url.pathname === '/auth/logout') {
    const sess = getSession(req);
    if (sess) {
      console.log(`[AUTH] ${sess.email} signed out`);
      sessions.delete(sess.id);
    }
    clearSessionCookie(res);
    res.writeHead(302, { Location: '/login' });
    res.end();
    return;
  }

  if (url.pathname === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(loginPage());
    return;
  }

  // ── Auth gate ────────────────────────────────────────────────
  if (AUTH_ENABLED && !getSession(req)) {
    if (url.pathname === '/api/board-data') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    res.writeHead(302, { Location: '/login' });
    res.end();
    return;
  }

  // ── API ──────────────────────────────────────────────────────
  if (url.pathname === '/api/meetings') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ meetings: cachedMeetings, fetchedAt: new Date(meetingsLastFetch).toISOString() }));
    return;
  }

  if (url.pathname === '/api/board-data') {
    if (!cachedBoardData) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Data not yet loaded, try again in a moment' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...cachedBoardData, cacheAge: Math.round((Date.now() - lastFetch) / 1000) }));
    return;
  }

  if (url.pathname === '/api/overview') {
    await refreshOverviewIfNeeded();
    if (!cachedOverviewData) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Overview data not yet loaded' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...cachedOverviewData, cacheAge: Math.round((Date.now() - overviewLastFetch) / 1000) }));
    return;
  }

  if (url.pathname === '/api/artists') {
    if (!cachedArtistData) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Artist data not yet loaded' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...cachedArtistData, cacheAge: Math.round((Date.now() - lastFetch) / 1000) }));
    return;
  }

  // PATCH /api/artists/:id — update artist fields back to AirTable
  if (url.pathname.startsWith('/api/artists/') && req.method === 'PATCH') {
    const recordId = url.pathname.split('/api/artists/')[1];
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { fields } = JSON.parse(body);
        const atRes = await fetch(`https://api.airtable.com/v0/${BASE_ID}/Artists/${recordId}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${AT_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields }),
        });
        const atData = await atRes.json();
        if (atData.error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: atData.error }));
        } else {
          // Trigger a fresh artist data rebuild so the cache is current
          cachedArtistData = await buildArtistData();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, record: atData, refreshed: true }));
        }
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── /api/milestones ──────────────────────────────────────────
  if (url.pathname === '/api/milestones') {
    try {
      const now = Date.now();
      if (!cachedMilestonesData || now - milestonesLastFetch > MILESTONES_TTL_MS) {
        cachedMilestonesData = await buildMilestonesData();
        milestonesLastFetch = now;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...cachedMilestonesData, cacheAge: Math.round((Date.now() - milestonesLastFetch) / 1000) }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /sleep-demo — serve index.html with forceAsleep injected ──
  if (url.pathname === '/sleep-demo') {
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, html) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const injected = html.replace('window._klawPets = {};', 'window._klawPets = {}; window._forceAsleepOnLoad = true;');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(injected);
    });
    return;
  }

// ── Static files ─────────────────────────────────────────────
  let filePath = path.join(__dirname, url.pathname === '/' ? 'index.html' : url.pathname).split('?')[0];
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' }[path.extname(filePath)] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// ── Boot ───────────────────────────────────────────────────────
(async () => {
  if (AUTH_ENABLED) {
    console.log(`[AUTH] 🔐 Google OAuth enabled — @${ALLOWED_DOMAIN} only`);
    console.log(`[AUTH] Callback URL: ${BASE_URL}/auth/google/callback`);
  } else {
    console.log('[AUTH] ⚠️  No OAuth credentials — running without auth (set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET to enable)');
  }
  console.log('[BOOT] Loading lookup tables...');
  await loadLookups();
  loadMoves();
  console.log('[BOOT] Starting initial AirTable poll...');
  await poll().catch(console.error);
  console.log('[BOOT] Starting initial meetings poll...');
  pollMeetings().catch(console.error);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[BOOT] ✅ PROD Command server running → http://localhost:${PORT}`);
    console.log(`[BOOT] 🌐 Local network → http://172.18.62.28:${PORT}`);
  });
})();
