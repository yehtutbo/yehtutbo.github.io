const express = require('express');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const CONFIG_FILE = path.join(__dirname, 'config.json');
const AUTH_FILE   = path.join(__dirname, 'auth.json');
const LOG_FILE    = path.join(__dirname, 'stream.log');

// ── Token system (HMAC-SHA256, no external deps) ──────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
const TOKEN_TTL  = 8 * 60 * 60 * 1000; // 8 hours ms

function signToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body   = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL })).toString('base64url');
  const sig    = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  try {
    const [header, body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

// ── Password hashing (PBKDF2 — no bcrypt needed) ──────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100_000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const attempt = crypto.pbkdf2Sync(password, salt, 100_000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(attempt, 'hex'));
  } catch { return false; }
}

// ── Auth store ────────────────────────────────────────────────────────────
function loadAuth() {
  try {
    if (fs.existsSync(AUTH_FILE)) return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {}
  return null;
}

function saveAuth(data) {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function isSetupDone() { return !!loadAuth(); }

// ── Rate limiting (in-memory per IP) ─────────────────────────────────────
const loginAttempts = {};
const RATE_WINDOW   = 15 * 60 * 1000;
const MAX_ATTEMPTS  = 5;

function checkRateLimit(ip) {
  const now = Date.now();
  if (!loginAttempts[ip]) loginAttempts[ip] = [];
  loginAttempts[ip] = loginAttempts[ip].filter(t => now - t < RATE_WINDOW);
  return loginAttempts[ip].length >= MAX_ATTEMPTS;
}

function recordAttempt(ip) {
  if (!loginAttempts[ip]) loginAttempts[ip] = [];
  loginAttempts[ip].push(Date.now());
}

function getRemainingAttempts(ip) {
  const now = Date.now();
  if (!loginAttempts[ip]) return MAX_ATTEMPTS;
  const recent = loginAttempts[ip].filter(t => now - t < RATE_WINDOW);
  return Math.max(0, MAX_ATTEMPTS - recent.length);
}

// ── Auth middleware ───────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  const token  = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Token invalid or expired' });
  req.user = payload;
  next();
}

// ── Config helpers ────────────────────────────────────────────────────────
function generateIngestKey() {
  return crypto.randomBytes(12).toString('hex'); // 24-char hex key
}

const DEFAULT_CONFIG = {
  ingestKey: generateIngestKey(),
  destinations: [],
  autoRestart: false,
  maxLogLines: 500,
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE))
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch (e) { console.error('Config error:', e.message); }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }

// ── Active streams ────────────────────────────────────────────────────────
const activeStreams = {};
let streamLog = [];

function appendLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  streamLog.push(line);
  if (streamLog.length > 1000) streamLog = streamLog.slice(-1000);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// ── nginx stats ───────────────────────────────────────────────────────────
const HISTORY_MAX = 60;
const bitrateHistory = { bwIn: [], bwOut: [], timestamps: [] };
let _lastBytesIn   = 0;
let _lastBytesOut  = 0;
let _lastStatTime  = 0;
let _lastBwIn      = 0; // holds last known ingest bitrate to smooth stalled counters
let _lastTotalBytesSent = 0;
let _bytesInOffset  = 0;
let _bytesOutOffset = 0;
let _trafficResetAt = null;

function getNginxStats() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:8080/stat', (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

function parseRtmpStats(xml) {
  const now = Date.now();

  // ── Total bytes from nginx (for traffic counter display) ─────────────
  let bytesIn = 0, bytesOut = 0;
  if (xml) {
    const topXml = xml.split('<server>')[0] || xml;
    bytesIn  = parseInt((topXml.match(/<bytes_in>(\d+)<\/bytes_in>/)   || [])[1] || 0);
    bytesOut = parseInt((topXml.match(/<bytes_out>(\d+)<\/bytes_out>/) || [])[1] || 0);
    _lastBytesIn  = bytesIn;
    _lastBytesOut = bytesOut;
    _lastStatTime = now;
  }

  // ── bwIn: from dedicated ingest probe process ─────────────────────────
  // Probe reads ingest stream → null, reports bitrate via stderr
  // Independent of relay destinations
  const activeList = Object.values(activeStreams);
  const hasStreams  = activeList.length > 0;

  let bwIn = null;
  if (ingestActive) {
    if (_ingestBwCache > 0) {
      // Probe is reporting — use it
      bwIn      = _ingestBwCache;
      _lastBwIn = bwIn;
    } else if (_lastBwIn > 0) {
      // Probe not yet reporting — hold last known
      bwIn = _lastBwIn;
    } else {
      bwIn = 0; // encoder connected, probe starting
    }
  } else {
    _lastBwIn = 0;
  }

  // ── bwOut: sum of all relay process bitrates ──────────────────────────
  const ffmpegBwOut = activeList.reduce((sum, s) => sum + (s.bitrate || 0), 0);
  const bwOut = hasStreams && ffmpegBwOut > 0 ? ffmpegBwOut : (hasStreams ? 0 : null);

  // ── isLive ────────────────────────────────────────────────────────────
  const isLive = ingestActive;

  // ── Update state ──────────────────────────────────────────────────────
  _lastBytesIn  = bytesIn;
  _lastBytesOut = bytesOut;
  _lastStatTime = now;

  // ── History ───────────────────────────────────────────────────────────
  bitrateHistory.bwIn.push(isLive ? bwIn : null);
  bitrateHistory.bwOut.push(hasStreams ? bwOut : null);
  bitrateHistory.timestamps.push(now);
  if (bitrateHistory.bwIn.length > HISTORY_MAX) {
    bitrateHistory.bwIn.shift();
    bitrateHistory.bwOut.shift();
    bitrateHistory.timestamps.shift();
  }

  return {
    clients: 0, isLive,
    bwIn:  isLive    ? bwIn  : null,
    bwOut: hasStreams ? bwOut : null,
    bytesIn, bytesOut,
  };
}

// ── Ingest probe ──────────────────────────────────────────────────────────
// Reads stream info once on connect to get ingest bitrate from codec headers
let _ingestBwCache = 0;
let _ingestProc    = null;

function startIngestProbe(streamKey) {
  if (_ingestProc) {
    _ingestProc.kill('SIGTERM');
    _ingestProc = null;
  }
  if (!ingestActive) return;

  // Use ffmpeg with -progress to get regular bitrate updates
  const args = [
    '-rtmp_live', 'live',
    '-i', `rtmp://127.0.0.1:1935/live/${streamKey}`,
    '-c', 'copy',
    '-f', 'null', '-',
    '-progress', 'pipe:2',  // force progress output to stderr
    '-stats_period', '2'    // update every 2 seconds
  ];

  _ingestProc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

  let buf = '';

  _ingestProc.stderr.on('data', (chunk) => {
    buf += chunk.toString();

    // Parse -progress output (key=value lines)
    // bitrate line: "bitrate=4056.0kbits/s"
    const bitrateMatch = buf.match(/bitrate=\s*([\d.]+)\s*kbits\/s/g);
    if (bitrateMatch) {
      const last = bitrateMatch[bitrateMatch.length - 1];
      const val = parseFloat(last.match(/([\d.]+)/)[1]) * 1000;
      if (val > 0) {
        _ingestBwCache = Math.round(val);
        _lastBwIn      = _ingestBwCache;
      }
    }

    // Also parse stream header as initial fallback
    if (_ingestBwCache === 0) {
      let total = 0;
      const vm = buf.match(/Video:.*?,\s*([\d]+)\s*kb\/s/);
      const am = buf.match(/Audio:.*?,\s*([\d]+)\s*kb\/s/);
      if (vm) total += parseInt(vm[1]);
      if (am) total += parseInt(am[1]);
      if (total > 0) {
        _ingestBwCache = total * 1000;
        _lastBwIn      = _ingestBwCache;
      }
    }

    // Keep buffer from growing too large
    if (buf.length > 16000) buf = buf.slice(-8000);
  });

  _ingestProc.on('exit', (code) => {
    _ingestProc = null;
    appendLog(`[PROBE] Ingest probe exited (${code})`);
    if (ingestActive) {
      setTimeout(() => startIngestProbe(streamKey), 3000);
    }
  });

  appendLog('[PROBE] Ingest bitrate probe started');
}

function stopIngestProbe() {
  if (_ingestProc) {
    _ingestProc.kill('SIGTERM');
    _ingestProc = null;
  }
  _ingestBwCache = 0;
}


const streamHistory = [];
const MAX_HISTORY = 50;

function recordSessionEnd(session) {
  session.endedAt  = new Date().toISOString();
  session.duration = Date.now() - session.startedAtMs;
  streamHistory.unshift(session);
  if (streamHistory.length > MAX_HISTORY) streamHistory.pop();
}

// ── Ingest state tracker ──────────────────────────────────────────────────
let ingestActive   = false;   // OBS currently publishing
let _autoStartPending = false;

let _currentSession = null;

// Called when OBS starts streaming → start all enabled destinations
function onIngestStart(streamKey) {
  const cfg = loadConfig();
  if (streamKey !== cfg.ingestKey) {
    appendLog(`[WARN] Unknown stream key attempted: ${streamKey}`);
    return;
  }
  if (ingestActive) return;
  ingestActive = true;
  _ingestBwCache = 0; // clear stale cache from previous session
  _lastBwIn      = 0;
  appendLog(`[INGEST] OBS connected — key: ${streamKey.slice(0,6)}...`);

  // Start probe (2s delay for stream to stabilize)
  setTimeout(() => startIngestProbe(streamKey), 2000);


  // Begin new session record
  _currentSession = {
    id:          Date.now().toString(),
    startedAt:   new Date().toISOString(),
    startedAtMs: Date.now(),
    bytesInStart:  _lastBytesIn,
    bytesOutStart: _lastBytesOut,
    destinations: [],
  };

  if (!cfg.autoRestart) return;

  _autoStartPending = true;
  setTimeout(() => {
    _autoStartPending = false;
    const current = loadConfig();
    if (!ingestActive) return;
    const dests = current.destinations.filter(d => d.enabled);
    if (!dests.length) return;
    appendLog(`[AUTO] OBS reconnected — starting ${dests.length} destination(s)...`);
    dests.forEach(d => {
      if (!activeStreams[d.id]) startStream(d);
    });
  }, 3000);
}

// Called when OBS stops streaming → stop all ffmpeg processes
function onIngestStop(streamKey) {
  ingestActive = false;
  _autoStartPending = false;
  appendLog(`[INGEST] OBS disconnected`);

  // Snapshot session BEFORE stopping probe/streams/resetting vars
  if (_currentSession) {
    const destSnapshots = Object.values(activeStreams).map(s => ({
      name: s.destName, bytesSent: s.bytesSent,
    }));

    // totalBytesOut = sum of all relay ffmpeg bytesSent
    const totalOut = destSnapshots.reduce((sum, d) => sum + (d.bytesSent || 0), 0);

    // totalBytesIn = estimate from session duration × ingest bitrate
    // (nginx bytes_in counter is unreliable on this server)
    const durationMs   = Date.now() - _currentSession.startedAtMs;
    const durationSec  = durationMs / 1000;
    const ingestBps    = _lastBwIn || _ingestBwCache || 0;
    const totalIn      = Math.round(ingestBps / 8 * durationSec); // bits/s ÷ 8 = bytes/s

    _currentSession.destinations   = destSnapshots;
    _currentSession.totalBytesIn   = totalIn;
    _currentSession.totalBytesOut  = totalOut;
    recordSessionEnd(_currentSession);
    _currentSession = null;
  }

  stopIngestProbe();

  // Reset bitrate tracking for next session
  _lastStatTime  = 0;
  _lastBytesIn   = 0;
  _lastBwIn      = 0;

  // Kill all active streams — they will error anyway without ingest
  const ids = Object.keys(activeStreams);
  if (ids.length) {
    appendLog(`[AUTO] Stopping ${ids.length} stream(s) — no ingest signal`);
    ids.forEach(id => {
      if (activeStreams[id]) {
        activeStreams[id].proc.kill('SIGTERM');
        delete activeStreams[id];
      }
    });
  }
}

// ── Stream helpers ────────────────────────────────────────────────────────
function startStream(dest) {
  const cfg = loadConfig();
  if (activeStreams[dest.id]) return { success: false, message: 'Already running' };
  const rtmpUrl = dest.url.endsWith('/') ? dest.url + dest.key : `${dest.url}/${dest.key}`;
  const args = ['-re', '-i', `rtmp://127.0.0.1:1935/live/${cfg.ingestKey}`,
    '-c', 'copy', '-f', 'flv', rtmpUrl];
  appendLog(`[START] → ${dest.name}: ${dest.url}`);
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  activeStreams[dest.id] = { proc, status: 'connecting', startTime: Date.now(),
    destName: dest.name, bytesSent: 0, errors: 0, speed: null };
  proc.stderr.on('data', (data) => {
    const line = data.toString();
    // ffmpeg progress lines contain frame= or fps= or bitrate=
    if (line.includes('frame=') || line.includes('fps=') || line.includes('bitrate=')) {
      if (activeStreams[dest.id]) {
        activeStreams[dest.id].status = 'live';

        // Speed: speed=   1x  or  speed=1.01x
        const mSpeed = line.match(/speed=\s*([\d.]+)x/);
        if (mSpeed) activeStreams[dest.id].speed = parseFloat(mSpeed[1]);

        // Size: "size=   1234kB" or "size=1234KiB" or "size=1234 kB"
        const mSize = line.match(/size=\s*(\d+)\s*[kK][iI]?[bB]/);
        if (mSize) {
          activeStreams[dest.id].bytesSent = parseInt(mSize[1]) * 1024;
        }

        // Bitrate: "bitrate= 4500.0kbits/s" — use as fallback for bwOut
        const mBr = line.match(/bitrate=\s*([\d.]+)\s*kbits\/s/);
        if (mBr) activeStreams[dest.id].bitrate = parseFloat(mBr[1]) * 1000; // bits/s
      }
    } else if (line.includes('Error') || line.includes('error') || line.includes('refused') || line.includes('failed')) {
      if (activeStreams[dest.id]) activeStreams[dest.id].errors++;
      appendLog(`[ERROR] ${dest.name}: ${line.trim().slice(0, 120)}`);
    }
  });
  proc.on('exit', (code) => {
    appendLog(`[STOP] ${dest.name} exited (code ${code})`);
    if (activeStreams[dest.id]) {
      const wasLive = activeStreams[dest.id].status === 'live';
      delete activeStreams[dest.id];
      if (wasLive && loadConfig().autoRestart) {
        appendLog(`[AUTO] Restarting ${dest.name} in 5s...`);
        setTimeout(() => startStream(dest), 5000);
      }
    }
  });
  return { success: true, message: `Started ${dest.name}` };
}

function stopStream(destId) {
  if (!activeStreams[destId]) return { success: false, message: 'Not running' };
  const s = activeStreams[destId];
  appendLog(`[STOP] Stopping ${s.destName}`);
  s.proc.kill('SIGTERM');
  delete activeStreams[destId];
  return { success: true, message: `Stopped ${s.destName}` };
}

// ── nginx-rtmp callbacks (called by nginx internally, localhost only) ──────
// These must be PUBLIC (no auth) — nginx calls them server-side

app.post('/rtmp/on_publish', express.urlencoded({ extended: false }), (req, res) => {
  const key = req.body?.name || req.query?.name || '';
  onIngestStart(key);
  res.sendStatus(200); // 200 = allow, 4xx = deny
});

app.post('/rtmp/on_publish_done', express.urlencoded({ extended: false }), (req, res) => {
  const key = req.body?.name || req.query?.name || '';
  onIngestStop(key);
  res.sendStatus(200);
});

// Also handle GET (some nginx-rtmp versions use GET)
app.get('/rtmp/on_publish', (req, res) => {
  onIngestStart(req.query?.name || '');
  res.sendStatus(200);
});

app.get('/rtmp/on_publish_done', (req, res) => {
  onIngestStop(req.query?.name || '');
  res.sendStatus(200);
});

// ═══════════════════════════════════════════════════════════════════════════
//  PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/auth/setup-status', (req, res) => {
  res.json({ setupRequired: !isSetupDone() });
});

app.post('/api/auth/setup', (req, res) => {
  if (isSetupDone()) return res.status(400).json({ error: 'Setup already completed' });
  const { username, password } = req.body;
  if (!username?.trim() || !password)
    return res.status(400).json({ error: 'username and password required' });
  if (username.trim().length < 3)
    return res.status(400).json({ error: 'Username minimum 3 characters' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password minimum 8 characters' });

  const auth = {
    username: username.toLowerCase().trim(),
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
    lastLogin: null,
    loginCount: 0,
  };
  saveAuth(auth);
  appendLog(`[AUTH] Admin account created: ${auth.username}`);
  res.json({ success: true });
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (checkRateLimit(ip)) {
    return res.status(429).json({
      error: 'Too many failed attempts. Please wait 15 minutes.',
      retryAfter: 900
    });
  }
  const { username, password } = req.body;
  const auth = loadAuth();
  if (!auth) return res.status(400).json({ error: 'Setup not completed' });

  const valid = username?.toLowerCase().trim() === auth.username &&
                verifyPassword(password, auth.passwordHash);

  if (!valid) {
    recordAttempt(ip);
    const remaining = getRemainingAttempts(ip);
    appendLog(`[AUTH] Failed login from ${ip} (${remaining} attempts left)`);
    return res.status(401).json({
      error: 'Invalid username or password',
      remainingAttempts: remaining
    });
  }

  auth.lastLogin = new Date().toISOString();
  auth.loginCount = (auth.loginCount || 0) + 1;
  saveAuth(auth);

  const token = signToken({ username: auth.username });
  appendLog(`[AUTH] ✓ Login: ${auth.username} from ${ip}`);
  res.json({
    success: true, token,
    username: auth.username,
    lastLogin: auth.lastLogin,
    expiresIn: TOKEN_TTL
  });
});

app.get('/api/auth/verify', requireAuth, (req, res) => {
  const auth = loadAuth();
  res.json({
    valid: true,
    username: req.user.username,
    lastLogin: auth?.lastLogin,
    loginCount: auth?.loginCount,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  PROTECTED ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const auth = loadAuth();
  if (!verifyPassword(currentPassword, auth.passwordHash))
    return res.status(401).json({ error: 'Current password is incorrect' });
  if (!newPassword || newPassword.length < 8)
    return res.status(400).json({ error: 'New password minimum 8 characters' });

  auth.passwordHash = hashPassword(newPassword);
  saveAuth(auth);
  appendLog(`[AUTH] Password changed by ${req.user.username}`);
  res.json({ success: true, message: 'Password changed successfully' });
});

app.get('/api/status', requireAuth, async (req, res) => {
  const cfg  = loadConfig();
  const xml  = await getNginxStats();
  const rtmp = parseRtmpStats(xml);
  const auth = loadAuth();

  // Detect real server host from request (works behind nginx proxy)
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost:8080';
  const serverIp = host.split(':')[0];
  const ingestUrl = `rtmp://${serverIp}:1935/live/${cfg.ingestKey}`;

  const destinations = cfg.destinations.map(d => ({
    ...d, key: d.key ? '••••••' + d.key.slice(-4) : '',
    active: !!activeStreams[d.id],
    streamStatus: activeStreams[d.id]?.status || 'stopped',
    uptime:    activeStreams[d.id] ? Date.now() - activeStreams[d.id].startTime : 0,
    bytesSent: activeStreams[d.id]?.bytesSent || 0,
    speed:     activeStreams[d.id]?.speed || null,
  }));

  res.json({
    nginx: rtmp, ingestKey: cfg.ingestKey,
    ingestUrl,
    isLive: rtmp.isLive,
    bwIn:   rtmp.bwIn,
    bwOut:  rtmp.bwOut,
    bytesIn:  Math.max(0, (rtmp.bytesIn  || 0) - _bytesInOffset),
    bytesOut: Math.max(0,
      Object.values(activeStreams).reduce((s, st) => s + (st.bytesSent||0), 0) - _bytesOutOffset
    ),
    trafficResetAt: _trafficResetAt,
    bitrateHistory: {
      bwIn:  bitrateHistory.bwIn.slice(-30),
      bwOut: bitrateHistory.bwOut.slice(-30),
    },
    destinations, autoRestart: cfg.autoRestart,
    activeCount: Object.keys(activeStreams).length,
    adminUser: auth?.username, lastLogin: auth?.lastLogin,
    loginCount: auth?.loginCount, timestamp: Date.now(),
    streamHistory: streamHistory.slice(0, 20),
  });
});

app.get('/api/config', requireAuth, (req, res) => res.json(loadConfig()));

app.post('/api/config', requireAuth, (req, res) => {
  const current = loadConfig();
  const updated  = { ...current, ...req.body };
  // Ensure ingestKey is never empty
  if (!updated.ingestKey || !updated.ingestKey.trim()) {
    updated.ingestKey = generateIngestKey();
  }
  updated.ingestKey = updated.ingestKey.trim().replace(/[^a-zA-Z0-9_\-]/g, '');
  saveConfig(updated);
  appendLog(`[CONFIG] Updated by ${req.user.username}`);
  res.json({ success: true, config: updated });
});

// Regenerate ingest key
app.post('/api/config/regenerate-key', requireAuth, (req, res) => {
  const cfg = loadConfig();
  const oldKey = cfg.ingestKey;
  cfg.ingestKey = generateIngestKey();
  saveConfig(cfg);
  appendLog(`[CONFIG] Ingest key regenerated by ${req.user.username} (old: ${oldKey.slice(0,6)}...)`);
  res.json({ success: true, ingestKey: cfg.ingestKey });
});

app.post('/api/destinations', requireAuth, (req, res) => {
  const { name, url, key, platform, enabled } = req.body;
  if (!name || !url || !key) return res.status(400).json({ error: 'name, url, key required' });
  const cfg = loadConfig();
  const dest = { id: Date.now().toString(), name, url: url.replace(/\/$/, ''), key,
    platform: platform || 'custom', enabled: enabled !== false, createdAt: new Date().toISOString() };
  cfg.destinations.push(dest);
  saveConfig(cfg);
  appendLog(`[DEST] Added: ${name} by ${req.user.username}`);
  res.json({ success: true, destination: { ...dest, key: '••••••' + key.slice(-4) } });
});

app.put('/api/destinations/:id', requireAuth, (req, res) => {
  const cfg = loadConfig();
  const idx = cfg.destinations.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  cfg.destinations[idx] = { ...cfg.destinations[idx], ...req.body };
  saveConfig(cfg);
  res.json({ success: true });
});

app.delete('/api/destinations/:id', requireAuth, (req, res) => {
  const cfg  = loadConfig();
  const dest = cfg.destinations.find(d => d.id === req.params.id);
  if (!dest) return res.status(404).json({ error: 'Not found' });
  stopStream(req.params.id);
  cfg.destinations = cfg.destinations.filter(d => d.id !== req.params.id);
  saveConfig(cfg);
  appendLog(`[DEST] Removed: ${dest.name} by ${req.user.username}`);
  res.json({ success: true });
});

app.post('/api/stream/:id/start', requireAuth, (req, res) => {
  const dest = loadConfig().destinations.find(d => d.id === req.params.id);
  if (!dest) return res.status(404).json({ error: 'Destination not found' });
  res.json(startStream(dest));
});

app.post('/api/stream/:id/stop', requireAuth, (req, res) =>
  res.json(stopStream(req.params.id)));

app.post('/api/stream/start-all', requireAuth, (req, res) => {
  const results = loadConfig().destinations.filter(d => d.enabled)
    .map(d => ({ id: d.id, name: d.name, ...startStream(d) }));
  res.json({ results });
});

app.post('/api/stream/stop-all', requireAuth, (req, res) => {
  const ids = Object.keys(activeStreams);
  ids.forEach(id => stopStream(id));
  res.json({ stopped: ids.length });
});

app.get('/api/logs', requireAuth, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  res.json({ logs: streamLog.slice(-limit) });
});

app.post('/api/nginx/restart', requireAuth, (req, res) => {
  exec('sudo systemctl restart nginx', (err, _, stderr) => {
    if (err) return res.json({ success: false, error: stderr });
    appendLog(`[NGINX] Restarted by ${req.user.username}`);
    res.json({ success: true });
  });
});

app.post('/api/stats/reset-traffic', requireAuth, (req, res) => {
  _bytesInOffset  = _lastBytesIn;
  _bytesOutOffset = Object.values(activeStreams).reduce((s, st) => s + (st.bytesSent||0), 0);
  _trafficResetAt = new Date().toISOString();
  bitrateHistory.bwIn  = [];
  bitrateHistory.bwOut = [];
  bitrateHistory.timestamps = [];
  appendLog(`[STATS] Traffic counters reset by ${req.user.username}`);
  res.json({ success: true, resetAt: _trafficResetAt });
});

// ── Static files + SPA fallback ──────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');

// CSP headers permissive enough for the dashboard
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "media-src 'self' blob:",
    ].join('; ')
  );
  next();
});

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  },
}));

// Explicit root — ensures index.html always serves even if static middleware misses
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// SPA fallback — any unmatched GET returns index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '127.0.0.1', () => {
  appendLog(`[SERVER] Started on port ${PORT}`);
  if (!isSetupDone()) console.log('⚠  First run: visit the web UI to create admin account');
});

process.on('SIGTERM', () => {
  Object.keys(activeStreams).forEach(id => stopStream(id));
  process.exit(0);
});
