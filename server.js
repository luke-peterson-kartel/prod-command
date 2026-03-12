/**
 * PROD Command — AirTable Live Sync Server
 * Polls AirTable every 60s, serves /api/board-data
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const AT_KEY = process.env.AIRTABLE_KEY ||
  (() => { try { return fs.readFileSync(process.env.HOME + '/.config/airtable/api_key', 'utf8').trim(); } catch(e) { return ''; } })();
const BASE_ID = 'appRBFRW3pZ7rUDFh';
const TABLE_ID = 'tblCrQJIBuXscN4tq';
const VIEW_ID  = 'viwAAn6Xd4o6yw1Tc';
const PORT = process.env.PORT || 7341;

const COLUMNS = [
  'Creative Brief', 'LookDev', 'Storyboard', 'Animatic',
  'Rough Cut', 'Fine Cut', 'Final Delivery', 'Complete'
];

// ── Lookup tables ──────────────────────────────────────────────
let teamMembers = {};   // recXXX → { name, initials, color }
let clients = {};       // recXXX → companyName
let cachedBoardData = null;
let lastFetch = 0;

const PRODUCER_COLORS = {
  'Veronica Diaz':        { bg: '#0e7c5a', fg: '#00ff88' },
  'Monica Monique':       { bg: '#5c1a6e', fg: '#d46cff' },
  'Seb Webber':           { bg: '#1a3a5c', fg: '#00d4ff' },
  'Stuart Acher':         { bg: '#3a2a0e', fg: '#f59e0b' },
  'Wayan Palmieri':       { bg: '#0e7c5a', fg: '#00ff88' },
  'Estefania Guarderas':  { bg: '#1a3a5c', fg: '#00d4ff' },
  'Rebecca Cook':         { bg: '#2a1a5c', fg: '#818cf8' },
};

function initials(name) {
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function colorFor(name) {
  return PRODUCER_COLORS[name] || { bg: '#1a2a3a', fg: '#7a9bb5' };
}

// ── AirTable fetch helper ──────────────────────────────────────
function atFetch(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.airtable.com',
      path: path,
      headers: { 'Authorization': `Bearer ${AT_KEY}` }
    };
    https.get(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function fetchAllRecords(tableName, params = '') {
  let records = [];
  let offset = null;
  do {
    const qs = new URLSearchParams();
    if (offset) qs.set('offset', offset);
    if (params) {
      const extra = new URLSearchParams(params);
      for (const [k, v] of extra) qs.set(k, v);
    }
    const url = `/v0/${BASE_ID}/${encodeURIComponent(tableName)}?${qs}`;
    const data = await atFetch(url);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}

// ── Load lookup tables ─────────────────────────────────────────
async function loadLookups() {
  const [teamRecs, clientRecs] = await Promise.all([
    fetchAllRecords('Team Members'),
    fetchAllRecords('Clients')
  ]);
  teamRecs.forEach(r => {
    const name = r.fields['Full Name'] || '?';
    teamMembers[r.id] = { name, initials: initials(name), ...colorFor(name) };
  });
  clientRecs.forEach(r => {
    clients[r.id] = r.fields['Company Name'] || '?';
  });
  console.log(`[INIT] Loaded ${Object.keys(teamMembers).length} team members, ${Object.keys(clients).length} clients`);
}

// ── SLA helpers ───────────────────────────────────────────────
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0,0,0,0);
  const due = new Date(dateStr + 'T00:00:00');
  return Math.round((due - today) / 86400000);
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
  if (days < 0)  return 'overdue';
  if (days <= 3)  return 'at-risk';
  return '';
}

// ── Build SCRUM note (first non-empty line) ───────────────────
function scrumFirst(note) {
  if (!note) return '';
  const line = note.trim().split('\n').find(l => l.trim()) || '';
  return line.replace(/^\d+\/\d+\s*[-–]\s*/, '').trim().slice(0, 120);
}

function scrumDate(note) {
  if (!note) return '';
  const m = note.trim().match(/^(\d+\/\d+)/);
  return m ? m[1] : '';
}

// ── Build board data from AirTable records ────────────────────
async function buildBoardData() {
  const params = `view=${VIEW_ID}`;
  const records = await fetchAllRecords(TABLE_ID, params);

  const columns = {};
  COLUMNS.forEach(c => columns[c] = []);

  const bench = [];
  const complete = [];

  for (const r of records) {
    const f = r.fields;
    const prodStatus = f['Prod Status'];
    const status = f['Project Status'] || f['Status'] || '';

    // Resolve producer
    const producerIds = f['Producer'] || [];
    const producerRec = producerIds[0] ? teamMembers[producerIds[0]] : null;

    // Resolve company — fall back to parsing project name
    const companyIds = f['Company'] || [];
    let clientName = companyIds[0] ? clients[companyIds[0]] : '';
    if (!clientName) {
      // Try to extract client from "Client - Project Name" format
      const pname = f['Project Name'] || '';
      const parts = pname.split(/\s*[-–]\s*/);
      clientName = parts.length > 1 ? parts[0].trim() : pname;
    }

    // SLA
    const slaDate = f['Final Delivery Due Date (SOW)'] || null;
    const days = daysUntil(slaDate);
    const badge = slaBadge(days);
    const cardCls = cardStatus(days);

    // SCRUM note
    const scrum = f['SCRUM Status Note'] || '';
    const scrumNote = scrumFirst(scrum);
    const scrumDt = scrumDate(scrum);

    const card = {
      id: r.id,
      name: f['Project Name'] || 'Untitled',
      jobId: f['Project ID'] || '',
      client: clientName,
      producer: producerRec,
      slaDate,
      slaDays: days,
      slaBadge: badge,
      cardClass: cardCls,
      scrumNote,
      scrumDate: scrumDt,
      projectType: Array.isArray(f['Project Type']) ? f['Project Type'][0] : (f['Project Type'] || ''),
      invoiceStatus: f['Invoice Status'] || '',
      finalDelivery: f['Final Delivery (Actual)'] || null,
    };

    if (!prodStatus || prodStatus === '') {
      // No Prod Status set — use Project Status to place in Complete if applicable
      if (status === 'Complete') {
        complete.push({ ...card, slaBadge: { label: 'DONE', cls: 'done' } });
      }
      // ON HOLD / ON DECK without Prod Status → bench
      else if (status === 'ON HOLD') {
        bench.push({ ...card, benchStatus: 'ON HOLD' });
      } else if (status === 'On Deck') {
        bench.push({ ...card, benchStatus: 'ON DECK' });
      }
      // Otherwise skip (historical / no classification)
    } else if (prodStatus === 'N/A') {
      bench.push({
        ...card,
        benchStatus: status === 'ON HOLD' ? 'ON HOLD' : 'ON DECK',
      });
    } else if (COLUMNS.includes(prodStatus)) {
      columns[prodStatus].push(card);
    }
  }

  // Summary stats
  const allActive = Object.values(columns).flat();
  const onTrack = allActive.filter(c => !c.cardClass || c.cardClass === 'on-track').length;
  const atRisk  = allActive.filter(c => c.cardClass === 'at-risk').length;
  const overdue = allActive.filter(c => c.cardClass === 'overdue').length;

  return {
    fetchedAt: new Date().toISOString(),
    stats: {
      activeEngagements: allActive.length,
      onTrack, atRisk, overdue,
      benchCount: bench.length,
      completeCount: complete.length,
    },
    columns,
    bench,
    complete,
  };
}

// ── Poll loop ─────────────────────────────────────────────────
async function poll() {
  try {
    console.log('[POLL] Fetching AirTable data...');
    cachedBoardData = await buildBoardData();
    lastFetch = Date.now();
    console.log(`[POLL] ✓ ${cachedBoardData.stats.activeEngagements} active, ${cachedBoardData.stats.benchCount} bench, ${cachedBoardData.stats.completeCount} complete`);
  } catch(e) {
    console.error('[POLL] Error:', e.message);
  }
  setTimeout(poll, 60_000);
}

// ── HTTP server ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

  // Serve static files
  let filePath = path.join(__dirname, url.pathname === '/' ? 'index.html' : url.pathname);
  // Strip query string from file path
  filePath = filePath.split('?')[0];

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// ── Boot ──────────────────────────────────────────────────────
(async () => {
  console.log('[BOOT] Loading lookup tables...');
  await loadLookups();
  console.log('[BOOT] Starting initial AirTable poll...');
  await poll().catch(console.error);
  server.listen(PORT, () => {
    console.log(`[BOOT] ✅ PROD Command server running → http://localhost:${PORT}`);
    console.log(`[BOOT] API: http://localhost:${PORT}/api/board-data`);
  });
})();
