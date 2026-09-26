/**
 * WhatsApp service — uses whatsapp-web.js (real Chromium / WhatsApp Web)
 * because Baileys QR pairing is currently broken upstream
 * (companion_reg_refresh → phone shows "Couldn't link device").
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const AUTH_DIR = path.join(__dirname, '..', 'auth_info_wwebjs');
const BAILEYS_AUTH_DIR = path.join(__dirname, '..', 'auth_info_baileys');

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
let initializing = false;

function getConnectionStatus() {
  return connectionStatus;
}

function getLatestQR() {
  return latestQR;
}

function getLatestPairingCode() {
  return latestPairingCode;
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
  for (const dir of [AUTH_DIR, BAILEYS_AUTH_DIR]) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log('[wa] Cleared', dir);
      }
    } catch (err) {
      console.error('[wa] Auth cleanup error:', err.message);
    }
  }
  // wwebjs also stores under .wwebjs_auth by default — we pin dataPath
  const local = path.join(__dirname, '..', '.wwebjs_auth');
  const cache = path.join(__dirname, '..', '.wwebjs_cache');
  for (const dir of [local, cache]) {
    try {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function resolveChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
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
  try {
    client.removeAllListeners();
    await client.destroy().catch(() => undefined);
  } catch {
    // ignore
  }
  client = null;
}

async function resetSession() {
  console.log('[wa] Resetting WhatsApp session (wwebjs)...');
  await destroyClient();
  clearAuthFolder();
  latestQR = '';
  latestPairingCode = '';
  connectionStatus = STATUS.DISCONNECTED;
  connectPromise = null;
  await sleep(500);
  await connectWhatsApp();
  return {
    status: connectionStatus,
    hasQr: Boolean(latestQR),
    pairingCode: null,
  };
}

async function connectWhatsApp() {
  if (connectionStatus === STATUS.CONNECTED && client) return client;
  if (connectPromise) return connectPromise;

  connectPromise = openClient()
    .catch((err) => {
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
  if (initializing) {
    await sleep(1000);
    if (client) return client;
  }
  initializing = true;

  try {
    await destroyClient();

    const { Client, LocalAuth } = require('whatsapp-web.js');

    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const chromePath = resolveChromePath();
    console.log('[wa] Starting whatsapp-web.js', chromePath ? `chrome=${chromePath}` : '(default chrome)');

    const puppeteerOpts = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
      ],
    };
    if (chromePath) {
      puppeteerOpts.executablePath = chromePath;
    }

    const c = new Client({
      authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
      puppeteer: puppeteerOpts,
      qrMaxRetries: 10,
    });

    client = c;

    c.on('qr', (qr) => {
      latestQR = qr;
      connectionStatus = STATUS.NEED_QR;
      console.log('[wa] QR ready — open /qr and scan (Linked devices → Link a device)');
    });

    c.on('authenticated', () => {
      console.log('[wa] Authenticated (session saved)');
    });

    c.on('ready', () => {
      latestQR = '';
      connectionStatus = STATUS.CONNECTED;
      console.log('[wa] CONNECTED (whatsapp-web.js ready)');
    });

    c.on('auth_failure', (msg) => {
      console.error('[wa] auth_failure:', msg);
      connectionStatus = STATUS.DISCONNECTED;
      latestQR = '';
    });

    c.on('disconnected', (reason) => {
      console.log('[wa] disconnected:', reason);
      connectionStatus = STATUS.DISCONNECTED;
      latestQR = '';
      // Auto-reinit after short delay (unless intentional destroy)
      setTimeout(() => {
        if (connectionStatus !== STATUS.CONNECTED) {
          connectWhatsApp().catch((e) => console.error('[wa] reconnect failed:', e.message));
        }
      }, 4000);
    });

    c.on('loading_screen', (percent, message) => {
      console.log(`[wa] loading ${percent}% ${message || ''}`);
    });

    await c.initialize();
    return c;
  } finally {
    initializing = false;
  }
}

async function requestPairingCode(_phone) {
  const error = new Error(
    'Pairing code is not used with whatsapp-web.js. Open /qr and scan the QR code instead.'
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

function toChatId(digits) {
  return `${digits}@c.us`;
}

async function checkNumberStatus(phoneNumber) {
  return enqueue(() => lookupNumber(phoneNumber));
}

async function lookupNumber(phoneNumber) {
  if (connectionStatus !== STATUS.CONNECTED || !client) {
    const error = new Error('WhatsApp is not connected');
    error.statusCode = 503;
    throw error;
  }

  const normalized = formatPhoneNumber(phoneNumber);
  const chatId = toChatId(normalized);

  let exists = false;
  try {
    // Prefer isRegisteredUser when available
    if (typeof client.isRegisteredUser === 'function') {
      exists = Boolean(await client.isRegisteredUser(chatId));
    } else {
      const numberId = await client.getNumberId(chatId);
      exists = Boolean(numberId);
    }
  } catch (err) {
    // Some accounts return false / throw for invalid — treat as not registered
    console.warn('[wa] number check failed for', normalized, err.message);
    exists = false;
  }

  return {
    phoneNumber: normalized,
    exists,
    jid: exists ? chatId : null,
  };
}

async function checkBulkNumbers(numbersArray, delayMs = 1200, onProgress) {
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
  connectWhatsApp,
  resetSession,
  requestPairingCode,
  formatPhoneNumber,
  checkNumberStatus,
  checkBulkNumbers,
};
