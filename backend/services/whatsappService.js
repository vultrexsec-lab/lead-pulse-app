/**
 * WhatsApp via whatsapp-web.js (real Chromium + web.whatsapp.com).
 * Baileys QR pairing is unreliable (companion_reg_refresh); official Web works
 * for this account, so we use the same Web path through Puppeteer.
 */
const fs = require('fs');
const path = require('path');

const AUTH_DIR = path.join(__dirname, '..', 'auth_info_wwebjs');

const STATUS = {
  CONNECTED: 'CONNECTED',
  DISCONNECTED: 'DISCONNECTED',
  NEED_QR: 'NEED_QR',
};

let client = null;
let connectionStatus = STATUS.DISCONNECTED;
let connectPromise = null;
let checkQueue = Promise.resolve();
let latestQR = '';
let latestPairingCode = '';
let lastError = '';

function getConnectionStatus() {
  return connectionStatus;
}

function getLatestQR() {
  return latestQR;
}

function getLatestPairingCode() {
  return latestPairingCode;
}

function getLastError() {
  return lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueue(task) {
  const run = checkQueue.then(task, task);
  checkQueue = run.then(() => undefined, () => undefined);
  return run;
}

function clearAuthFolder() {
  const dirs = [
    AUTH_DIR,
    path.join(__dirname, '..', 'auth_info_baileys'),
    path.join(__dirname, '..', '.wwebjs_auth'),
    path.join(__dirname, '..', '.wwebjs_cache'),
  ];
  for (const dir of dirs) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log('[wa] Cleared', dir);
      }
    } catch (err) {
      console.error('[wa] clear error', dir, err.message);
    }
  }
}

function resolveChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
    'C:\\\\Program Files (x86)\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  try {
    const puppeteer = require('puppeteer');
    if (typeof puppeteer.executablePath === 'function') {
      const ep = puppeteer.executablePath();
      if (ep && fs.existsSync(ep)) return ep;
    }
  } catch {
    // ignore
  }

  return undefined;
}

async function destroyClient() {
  if (!client) return;
  const c = client;
  client = null;
  try {
    c.removeAllListeners();
  } catch {
    // ignore
  }
  try {
    await c.destroy();
  } catch {
    // ignore
  }
}

async function resetSession() {
  console.log('[wa] Resetting session...');
  await destroyClient();
  clearAuthFolder();
  latestQR = '';
  latestPairingCode = '';
  lastError = '';
  connectionStatus = STATUS.DISCONNECTED;
  connectPromise = null;
  await sleep(800);
  await connectWhatsApp();
  return {
    status: connectionStatus,
    hasQr: Boolean(latestQR),
    pairingCode: null,
    lastError: lastError || null,
  };
}

async function connectWhatsApp() {
  if (connectionStatus === STATUS.CONNECTED && client) return client;
  if (connectPromise) return connectPromise;

  connectPromise = openClient()
    .catch((err) => {
      lastError = err.message;
      console.error('[wa] openClient error:', err.message);
      connectionStatus = STATUS.DISCONNECTED;
      throw err;
    })
    .finally(() => {
      connectPromise = null;
    });

  return connectPromise;
}

async function openClient() {
  await destroyClient();

  let Client;
  let LocalAuth;
  try {
    ({ Client, LocalAuth } = require('whatsapp-web.js'));
  } catch (e) {
    throw new Error(
      'whatsapp-web.js not installed. Run: cd backend && npm install whatsapp-web.js'
    );
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const chromePath = resolveChromePath();
  if (!chromePath) {
    console.warn(
      '[wa] WARNING: No Chrome/Chromium found. Install Chrome or set PUPPETEER_EXECUTABLE_PATH'
    );
  } else {
    console.log('[wa] Using browser:', chromePath);
  }

  const puppeteerOpts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--mute-audio',
      '--hide-scrollbars',
    ],
  };
  if (chromePath) {
    puppeteerOpts.executablePath = chromePath;
  }

  const c = new Client({
    authStrategy: new LocalAuth({
      dataPath: AUTH_DIR,
      clientId: 'lead-pulse',
    }),
    puppeteer: puppeteerOpts,
    qrMaxRetries: 15,
    authTimeoutMs: 120000,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 10000,
  });

  client = c;

  c.on('qr', (qr) => {
    // whatsapp-web.js QR is the same payload official Web uses
    latestQR = qr;
    connectionStatus = STATUS.NEED_QR;
    lastError = '';
    console.log(
      '[wa] QR ready (official Web session) len=%s preview=%s',
      String(qr).length,
      String(qr).slice(0, 40)
    );
    console.log('[wa] Open /qr  →  scan like web.whatsapp.com (within ~60s)');
  });

  c.on('loading_screen', (percent, message) => {
    console.log(`[wa] loading ${percent}% ${message || ''}`);
  });

  c.on('authenticated', () => {
    console.log('[wa] Authenticated — session saving...');
  });

  c.on('ready', () => {
    latestQR = '';
    connectionStatus = STATUS.CONNECTED;
    lastError = '';
    console.log('[wa] CONNECTED — ready for number checks');
  });

  c.on('auth_failure', (msg) => {
    lastError = String(msg || 'auth_failure');
    connectionStatus = STATUS.DISCONNECTED;
    latestQR = '';
    console.error('[wa] auth_failure:', msg);
  });

  c.on('disconnected', (reason) => {
    console.log('[wa] disconnected:', reason);
    connectionStatus = STATUS.DISCONNECTED;
    latestQR = '';
    // soft reconnect
    setTimeout(() => {
      if (connectionStatus !== STATUS.CONNECTED) {
        connectWhatsApp().catch((e) => console.error('[wa] reconnect:', e.message));
      }
    }, 5000);
  });

  console.log('[wa] Starting whatsapp-web.js (same path as web.whatsapp.com)...');
  await c.initialize();
  return c;
}

async function requestPairingCode(_phone) {
  const error = new Error(
    'Use QR scan at /qr (same as web.whatsapp.com). Pairing code is not required with this engine.'
  );
  error.statusCode = 400;
  throw error;
}

function formatPhoneNumber(phoneNumber) {
  let digits = String(phoneNumber ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

  if (digits.length === 10 && /^(69|2)\d{8}$/.test(digits)) {
    digits = `30${digits}`;
  } else if (digits.length === 10 && /^[6-9]/.test(digits)) {
    digits = `91${digits}`;
  }

  if (!digits || digits.length < 8 || digits.length > 15) {
    const error = new Error('Valid phone number required');
    error.statusCode = 400;
    throw error;
  }
  return digits;
}

async function checkNumberStatus(phoneNumber) {
  return enqueue(() => lookupNumber(phoneNumber));
}

async function lookupNumber(phoneNumber) {
  if (connectionStatus !== STATUS.CONNECTED || !client) {
    const error = new Error('WhatsApp is not connected — open /qr and scan first');
    error.statusCode = 503;
    throw error;
  }

  const normalized = formatPhoneNumber(phoneNumber);
  const chatId = `${normalized}@c.us`;

  let exists = false;
  try {
    if (typeof client.isRegisteredUser === 'function') {
      exists = Boolean(await client.isRegisteredUser(chatId));
    } else {
      const numberId = await client.getNumberId(chatId);
      exists = Boolean(numberId);
    }
  } catch (err) {
    console.warn('[wa] check failed', normalized, err.message);
    exists = false;
  }

  return {
    phoneNumber: normalized,
    exists,
    jid: exists ? chatId : null,
  };
}

async function checkBulkNumbers(numbersArray, delayMs = 1000, onProgress) {
  if (!Array.isArray(numbersArray)) {
    const error = new Error('numbersArray must be an array');
    error.statusCode = 400;
    throw error;
  }

  const results = [];
  for (let index = 0; index < numbersArray.length; index += 1) {
    results.push(await checkNumberStatus(numbersArray[index]));
    if (typeof onProgress === 'function') {
      onProgress(index + 1, numbersArray.length);
    }
    if (index < numbersArray.length - 1) {
      await sleep(delayMs);
    }
  }
  return results;
}

module.exports = {
  STATUS,
  getConnectionStatus,
  getLatestQR,
  getLatestPairingCode,
  getLastError,
  connectWhatsApp,
  resetSession,
  requestPairingCode,
  formatPhoneNumber,
  checkNumberStatus,
  checkBulkNumbers,
};
