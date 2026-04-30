// api/lookup.js
// Hardened against scraping: rate limiting, bot detection, cached CSV map

const fs = require('fs');
const path = require('path');

// ─── IN-MEMORY CSV CACHE ───────────────────────────────────────────────────
// Vercel serverless functions are reused between warm invocations.
// We parse the CSV once and keep it in module-scope memory.
let cachedMap = null;        // Map<string, object>
let cacheBuiltAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // re-read file at most every 5 min

function getDataMap() {
  const now = Date.now();
  if (cachedMap && (now - cacheBuiltAt) < CACHE_TTL_MS) return cachedMap;

  const filePath = path.join(process.cwd(), 'data', 'final.csv');
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.trim().split(/\r?\n/);
  const delim = lines[0].includes('\t') ? '\t' : ',';

  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delim).map(c => c.trim());
    if (!cols[0]) continue;
    const key = cols[0].toUpperCase();
    map.set(key, {
      phy:   cols[1] === '-' ? '-' : (parseFloat(cols[1])  || 0),
      che:   cols[2] === '-' ? '-' : (parseFloat(cols[2])  || 0),
      mat:   cols[3] === '-' ? '-' : (parseFloat(cols[3])  || 0),
      total: cols[4] === '-' ? '-' : (parseFloat(cols[4])  || 0),
    });
  }

  cachedMap    = map;
  cacheBuiltAt = now;
  return map;
}

// ─── IN-MEMORY RATE LIMITER ────────────────────────────────────────────────
// Key: IP address → { count, windowStart }
// Limits per IP: MAX_REQUESTS requests per WINDOW_MS milliseconds.
// Also hard-caps total requests across ALL IPs per cold-start to protect
// against distributed scraping eating your invocation quota.

const ipWindows  = new Map();   // per-IP window tracking
const WINDOW_MS  = 60_000;      // 1-minute sliding window
const MAX_REQ_IP = 5;           // max lookups per IP per minute

// Global invocation counter (resets on each cold start / instance recycle)
let globalInvocations = 0;
const GLOBAL_LIMIT = 2000;      // hard ceiling per warm instance lifetime

// Lightweight cleanup: drop stale IP entries periodically so memory stays small
let lastCleanup = Date.now();
function maybeCleanup() {
  const now = Date.now();
  if (now - lastCleanup < 5 * 60_000) return;
  lastCleanup = now;
  for (const [ip, rec] of ipWindows) {
    if (now - rec.windowStart > WINDOW_MS * 2) ipWindows.delete(ip);
  }
}

function isRateLimited(ip) {
  const now = Date.now();
  maybeCleanup();

  let rec = ipWindows.get(ip);
  if (!rec || (now - rec.windowStart) > WINDOW_MS) {
    rec = { count: 0, windowStart: now };
    ipWindows.set(ip, rec);
  }

  rec.count++;
  return rec.count > MAX_REQ_IP;
}

// ─── BOT / SCRAPER HEURISTICS ──────────────────────────────────────────────
const BLOCKED_UA_PATTERNS = [
  /python-requests/i, /httpx/i, /aiohttp/i, /curl/i, /wget/i,
  /axios/i, /node-fetch/i, /go-http/i, /java\//i, /scrapy/i,
  /phantomjs/i, /headless/i, /selenium/i, /playwright/i, /puppeteer/i,
  /bot/i, /spider/i, /crawler/i,
];

const REQUIRED_HEADERS = ['accept-language']; // real browsers always send these

function isBot(req) {
  const ua = req.headers['user-agent'] || '';

  // Missing UA → definitely a script
  if (!ua) return true;

  // Known bad UAs
  if (BLOCKED_UA_PATTERNS.some(p => p.test(ua))) return true;

  // Missing expected browser headers
  for (const h of REQUIRED_HEADERS) {
    if (!req.headers[h]) return true;
  }

  return false;
}

// ─── INPUT VALIDATION ─────────────────────────────────────────────────────
// Karnataka CET numbers are typically 7 alphanumeric chars. Adjust if needed.
const CET_REGEX = /^[A-Z0-9]{4,12}$/;

// ─── HANDLER ──────────────────────────────────────────────────────────────
export default function handler(req, res) {
  // Only GET allowed
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Global invocation cap (protects your Vercel function limits)
  globalInvocations++;
  if (globalInvocations > GLOBAL_LIMIT) {
    return res.status(429).json({ error: 'Service temporarily unavailable. Try again later.' });
  }

  // Bot detection
  if (isBot(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Get real IP (Vercel sets x-forwarded-for)
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  // Per-IP rate limit
  if (isRateLimited(ip)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  }

  // Validate CET input
  const raw = (req.query.cet || '').trim().toUpperCase();
  if (!raw || !CET_REGEX.test(raw)) {
    return res.status(400).json({ error: 'Invalid CET number format.' });
  }

  // Lookup
  try {
    const map    = getDataMap();
    const record = map.get(raw);

    // Cache-control: short TTL so CDN doesn't cache, but browser can reuse briefly
    res.setHeader('Cache-Control', 'private, max-age=30');

    if (record) {
      return res.status(200).json(record);
    } else {
      return res.status(404).json({ error: 'Record not found.' });
    }
  } catch (err) {
    console.error('Lookup error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}