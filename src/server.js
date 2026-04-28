// ============================================================
// Engosoft Zoom Bot Server
// Joins meeting as host → muteAll → makeCoHost for lecturer
// ============================================================

const express = require('express');
const crypto  = require('crypto');
const puppeteer = require('puppeteer');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── Config ──────────────────────────────────────────────────
const CONFIG = {
  SDK_KEY    : process.env.ZOOM_SDK_KEY,
  SDK_SECRET : process.env.ZOOM_SDK_SECRET,
  BOT_NAME   : process.env.BOT_NAME    || 'Engosoft Bot',
  PORT       : process.env.PORT        || 3000,
  SECRET_KEY : process.env.SECRET_KEY,
};

// Validate required env vars on startup
['ZOOM_SDK_KEY', 'ZOOM_SDK_SECRET', 'SECRET_KEY'].forEach(key => {
  if (!process.env[key]) {
    console.error(`❌ Missing required env var: ${key}`);
    process.exit(1);
  }
});

// Active browser sessions: meetingNumber → { browser, page }
const sessions = new Map();

// ── Signature Generator ──────────────────────────────────────
function generateSignature(meetingNumber, role = 1) {
  const iat = Math.round(new Date().getTime() / 1000) - 30;
  const exp = iat + 60 * 60 * 2; // 2 hours

  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sdkKey: CONFIG.SDK_KEY,
    appKey: CONFIG.SDK_KEY,
    mn: meetingNumber,
    role,
    iat,
    exp,
    tokenExp: exp,
  })).toString('base64url');

  const signature = crypto
    .createHmac('sha256', CONFIG.SDK_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

// ── Auth Middleware ──────────────────────────────────────────
function auth(req, res, next) {
  const key = req.headers['x-bot-key'] || req.query.key;
  if (key !== CONFIG.SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Health Check ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size });
});

// ── GET Signature (for n8n or frontend) ──────────────────────
app.get('/signature', auth, (req, res) => {
  const { meetingNumber, role = 1 } = req.query;
  if (!meetingNumber) return res.status(400).json({ error: 'meetingNumber required' });
  res.json({ signature: generateSignature(meetingNumber, parseInt(role)) });
});

// ── JOIN Meeting ─────────────────────────────────────────────
app.post('/join', auth, async (req, res) => {
  const { meetingNumber, password = '', lecturerName = '', lecturerEmail = '' } = req.body;

  if (!meetingNumber) {
    return res.status(400).json({ error: 'meetingNumber required' });
  }

  if (sessions.has(meetingNumber)) {
    return res.json({ success: true, message: 'Already in meeting' });
  }

  res.json({ success: true, message: 'Bot joining...', meetingNumber });

  // Non-blocking — join in background
  joinMeeting({ meetingNumber, password, lecturerName, lecturerEmail }).catch(err => {
    console.error(`[Bot] Join failed for ${meetingNumber}:`, err.message);
    sessions.delete(meetingNumber);
  });
});

// ── LEAVE Meeting ─────────────────────────────────────────────
app.post('/leave', auth, async (req, res) => {
  const { meetingNumber } = req.body;
  const session = sessions.get(meetingNumber);
  if (!session) return res.status(404).json({ error: 'No session found' });

  try {
    await session.browser.close();
    sessions.delete(meetingNumber);
    res.json({ success: true, message: 'Left meeting' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── STATUS ────────────────────────────────────────────────────
app.get('/status/:meetingNumber', auth, (req, res) => {
  const active = sessions.has(req.params.meetingNumber);
  res.json({ active, sessions: [...sessions.keys()] });
});

// ── Core: Join via Puppeteer + Zoom Web SDK ───────────────────
async function joinMeeting({ meetingNumber, password, lecturerName, lecturerEmail }) {
  console.log(`[Bot] Launching browser for meeting ${meetingNumber}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--use-fake-ui-for-media-stream',   // Auto-allow mic/camera
      '--use-fake-device-for-media-stream',
      '--disable-features=VizDisplayCompositor',
    ],
  });

  const page = await browser.newPage();

  // Silence console noise
  page.on('console', msg => {
    if (msg.type() === 'error') console.error('[Browser]', msg.text());
  });

  // Store session
  sessions.set(meetingNumber, { browser, page, status: 'joining' });

  // Navigate to bot page
  const url = `http://127.0.0.1:${CONFIG.PORT}/bot.html` +
    `?mn=${encodeURIComponent(meetingNumber)}` +
    `&pwd=${encodeURIComponent(password)}` +
    `&name=${encodeURIComponent(CONFIG.BOT_NAME)}` +
    `&sig=${encodeURIComponent(generateSignature(meetingNumber, 1))}` +
    `&sdkKey=${encodeURIComponent(CONFIG.SDK_KEY)}` +
    `&lecturer=${encodeURIComponent(lecturerName)}` +
    `&lecturerEmail=${encodeURIComponent(lecturerEmail)}`;

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

  // Wait for SDK to initialize (up to 60s)
  try {
    await page.waitForFunction(() => window.__botStatus === 'joined', { timeout: 60000 });
    console.log(`[Bot] Joined meeting ${meetingNumber} ✅`);
    sessions.get(meetingNumber).status = 'joined';

    // Wait for muteAll confirmation
    await page.waitForFunction(() => window.__botStatus === 'muted', { timeout: 30000 });
    console.log(`[Bot] MuteAll done for ${meetingNumber} ✅`);

  } catch (e) {
    console.error(`[Bot] Timeout/error for ${meetingNumber}:`, e.message);
    await browser.close();
    sessions.delete(meetingNumber);
  }
}

// ── Start Server ──────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`🤖 Engosoft Zoom Bot running on port ${CONFIG.PORT}`);
});

module.exports = app;

// -- Zoom Challenge-Response -----------------------------------
app.post('/challenge', auth, (req, res) => {
  const { plainToken } = req.body;
  const crypto = require('crypto');
  const hash = crypto
    .createHmac('sha256', process.env.ZOOM_SECRET_TOKEN || '')
    .update(plainToken)
    .digest('hex');
  res.json({ plainToken, encryptedToken: hash });
});

// -- Zoom Webhook Handler (Challenge + Events) ----------------
app.post('/zoom-webhook', (req, res) => {
  const body = req.body;

  // Challenge-Response
  if (body.event === 'endpoint.url_validation') {
    const crypto = require('crypto');
    const hash = crypto
      .createHmac('sha256', process.env.ZOOM_SECRET_TOKEN || '')
      .update(body.payload.plainToken)
      .digest('hex');
    return res.json({ plainToken: body.payload.plainToken, encryptedToken: hash });
  }

  // Meeting Started
  if (body.event === 'meeting.started') {
    const obj = body.payload.object;
    res.json({ status: 'ok' });
    // Join async
    joinMeeting({
      meetingNumber: String(obj.id),
      password:      obj.password  || '',
      lecturerEmail: obj.host_email || '',
      lecturerName:  obj.host_email || ''
    }).catch(err => console.error('[Bot] Join error:', err.message));
    return;
  }

  res.json({ status: 'ignored' });
});
