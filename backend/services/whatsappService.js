/**
 * WhatsApp connector
 *
 * Default engine: Baileys from PR branch that handles companion_reg_refresh
 *   (fixes phone error: "Couldn't link device")
 * Optional: WA_ENGINE=wwebjs for whatsapp-web.js / Chromium
 */
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const axios = require('axios');

const ENGINE = String(process.env.WA_ENGINE || 'baileys').toLowerCase();
const AUTH_DIR_BAILEYS = path.join(__dirname, '..', 'auth_info_baileys');
const AUTH_DIR_WWEBJS = path.join(__dirname, '..', 'auth_info_wwebjs');

const STATUS = {
  CONNECTED: 'CONNECTED',
  DISCONNECTED: 'DISCONNECTED',
  NEED_QR: 'NEED_QR',
};

let sock = null;
let wwebClient = null;
let connectionStatus = STATUS.DISCONNECTED;
let connectPromise = null;
let checkQueue = Promise.resolve();
let latestQR = '';
let latestPairingCode = '';
let reconnectTimer = null;
let intentionalClose = false;

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });

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

function clearDir(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log('[wa] Cleared', dir);
    }
  } catch (err) {
    console.error('[wa] clear error', dir, err.message);
  }
}

function clearAuthFolder() {
  clearDir(AUTH_DIR_BAILEYS);
  clearDir(AUTH_DIR_WWEBJS);
  clearDir(path.join(__dirname, '..', '.wwebjs_auth'));
  clearDir(path.join(__dirname, '..', '.wwebjs_cache'));
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(delayMs = 2500) {
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWhatsApp().catch((err) => console.error('[wa] Reconnect failed:', err.message));
  }, delayMs);
}

// ─── Version helpers (Baileys) ───────────────────────────────────────────────

async function resolveWaVersion(baileysMod) {
  if (typeof baileysMod.fetchLatestWaWebVersion === 'function') {
    try {
      const r = await baileysMod.fetchLatestWaWebVersion();
      if (r?.version) {
        console.log('[wa] WA version (WaWeb):', r.version.join('.'));
        return r.version;
      }
    } catch (e) {
      console.warn('[wa] fetchLatestWaWebVersion:', e.message);
    }
  }

  if (typeof baileysMod.fetchLatestBaileysVersion === 'function') {
    try {
      const r = await baileysMod.fetchLatestBaileysVersion();
      if (r?.version) {
        console.log('[wa] WA version (Baileys):', r.version.join('.'));
        return r.version;
      }
    } catch (e) {
      console.warn('[wa] fetchLatestBaileysVersion:', e.message);
    }
  }

  try {
    const { data } = await axios.get('https://web.whatsapp.com/sw.js', {
      timeout: 12000,
      responseType: 'text',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      },
    });
    const m = String(data).match(/client_revision["'\s:=]+(\d{8,})/i);
    if (m) {
      const version = [2, 3000, Number(m[1])];
      console.log('[wa] WA version (sw.js):', version.join('.'));
      return version;
    }
  } catch (e) {
    console.warn('[wa] sw.js version scrape failed:', e.message);
  }

  return [2, 3000, 1023223821];
}

// ─── Baileys engine ──────────────────────────────────────────────────────────

async function destroyBaileys() {
  intentionalClose = true;
  clearReconnectTimer();
  try {
    if (sock) {
      try {
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('creds.update');
      } catch {
        // ignore
      }
      try {
        sock.end(undefined);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  sock = null;
  intentionalClose = false;
}

async function openBaileys() {
  await destroyBaileys();
  await sleep(400);

  // Prefer fixed fork (companion_reg_refresh). Falls back to npm package name.
  let baileysMod;
  try {
    baileysMod = await import('baileys');
  } catch {
    baileysMod = await import('@whiskeysockets/baileys');
  }

  const makeWASocket = baileysMod.default || baileysMod.makeWASocket;
  const {
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    Browsers,
  } = baileysMod;

  fs.mkdirSync(AUTH_DIR_BAILEYS, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR_BAILEYS);
  const version = await resolveWaVersion(baileysMod);

  const browser =
    typeof Browsers?.macOS === 'function'
      ? Browsers.macOS('Desktop')
      : ['Mac OS', 'Chrome', '14.4.1'];

  console.log('[wa] Baileys engine · browser=', JSON.stringify(browser), '· version=', version.join('.'));

  const socket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    browser,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    keepAliveIntervalMs: 30_000,
    qrTimeout: 60_000,
    getMessage: async () => undefined,
  });

  sock = socket;
  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    if (qr) {
      latestQR = qr;
      connectionStatus = STATUS.NEED_QR;
      const s = String(qr);
      console.log(
        '[wa] QR ready len=%s startsWithWaMe=%s preview=%s',
        s.length,
        s.startsWith('https://wa.me/'),
        s.slice(0, 60)
      );
      console.log('[wa] Open /qr (hard refresh) and scan within 60s');
    }

    if (isNewLogin) console.log('[wa] isNewLogin');

    if (connection === 'open') {
      latestQR = '';
      latestPairingCode = '';
      connectionStatus = STATUS.CONNECTED;
      clearReconnectTimer();
      console.log('[wa] CONNECTED (Baileys)');
    }

    if (connection === 'close') {
      if (intentionalClose) return;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log('[wa] close code=', statusCode, lastDisconnect?.error?.message || '');

      connectionStatus = STATUS.DISCONNECTED;
      sock = null;

      const loggedOut =
        statusCode === DisconnectReason?.loggedOut || statusCode === 401 || statusCode === 403;
      const restartRequired =
        statusCode === DisconnectReason?.restartRequired || statusCode === 515;

      if (loggedOut) {
        latestQR = '';
        clearDir(AUTH_DIR_BAILEYS);
        scheduleReconnect(1500);
        return;
      }

      if (restartRequired) {
        console.log('[wa] 515 restartRequired — reconnecting with saved session');
        scheduleReconnect(1000);
        return;
      }

      scheduleReconnect(3000);
    }
  });

  return socket;
}

async function baileysRequestPairingCode(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) {
    const error = new Error('Phone with country code required, e.g. 919876543210');
    error.statusCode = 400;
    throw error;
  }
  if (!sock) {
    await connectWhatsApp();
    await sleep(2500);
  }
  if (!sock?.requestPairingCode) {
    const error = new Error('Pairing code not available');
    error.statusCode = 503;
    throw error;
  }
  const code = await sock.requestPairingCode(digits);
  latestPairingCode = code;
  connectionStatus = STATUS.NEED_QR;
  console.log('[wa] pairing code:', code);
  return code;
}

async function baileysLookup(phoneNumber) {
  if (connectionStatus !== STATUS.CONNECTED || !sock) {
    const error = new Error('WhatsApp is not connected');
    error.statusCode = 503;
    throw error;
  }
  const normalized = formatPhoneNumber(phoneNumber);
  const results = await sock.onWhatsApp(normalized);
  const match = Array.isArray(results) ? results.find((item) => item?.exists) : null;
  return {
    phoneNumber: normalized,
    exists: Boolean(match?.exists),
    jid: match?.jid ?? null,
  };
}

// ─── whatsapp-web.js engine ──────────────────────────────────────────────────

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

async function destroyWweb() {
  if (!wwebClient) return;
  try {
    wwebClient.removeAllListeners();
    await wwebClient.destroy().catch(() => undefined);
  } catch {
    // ignore
  }
  wwebClient = null;
}

async function openWwebjs() {
  await destroyWweb();
  const { Client, LocalAuth } = require('whatsapp-web.js');
  fs.mkdirSync(AUTH_DIR_WWEBJS, { recursive: true });

  const chromePath = resolveChromePath();
  const puppeteerOpts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--disable-extensions',
    ],
  };
  if (chromePath) puppeteerOpts.executablePath = chromePath;

  console.log('[wa] wwebjs engine', chromePath || '(default chrome)');

  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_DIR_WWEBJS }),
    puppeteer: puppeteerOpts,
    qrMaxRetries: 12,
  });

  wwebClient = c;

  c.on('qr', (qr) => {
    latestQR = qr;
    connectionStatus = STATUS.NEED_QR;
    console.log('[wa] QR ready (wwebjs) → open /qr');
  });
  c.on('ready', () => {
    latestQR = '';
    connectionStatus = STATUS.CONNECTED;
    console.log('[wa] CONNECTED (wwebjs)');
  });
  c.on('auth_failure', (msg) => {
    console.error('[wa] wwebjs auth_failure', msg);
    connectionStatus = STATUS.DISCONNECTED;
  });
  c.on('disconnected', (reason) => {
    console.log('[wa] wwebjs disconnected', reason);
    connectionStatus = STATUS.DISCONNECTED;
    scheduleReconnect(4000);
  });

  await c.initialize();
  return c;
}

async function wwebLookup(phoneNumber) {
  if (connectionStatus !== STATUS.CONNECTED || !wwebClient) {
    const error = new Error('WhatsApp is not connected');
    error.statusCode = 503;
    throw error;
  }
  const normalized = formatPhoneNumber(phoneNumber);
  const chatId = `${normalized}@c.us`;
  let exists = false;
  try {
    if (typeof wwebClient.isRegisteredUser === 'function') {
      exists = Boolean(await wwebClient.isRegisteredUser(chatId));
    } else {
      const numberId = await wwebClient.getNumberId(chatId);
      exists = Boolean(numberId);
    }
  } catch (err) {
    console.warn('[wa] wweb check failed', normalized, err.message);
    exists = false;
  }
  return { phoneNumber: normalized, exists, jid: exists ? chatId : null };
}

// ─── Public API ──────────────────────────────────────────────────────────────

async function connectWhatsApp() {
  if (connectionStatus === STATUS.CONNECTED && (sock || wwebClient)) {
    return sock || wwebClient;
  }
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    if (ENGINE === 'wwebjs') {
      return openWwebjs();
    }
    return openBaileys();
  })()
    .catch((err) => {
      console.error('[wa] connect error:', err.message);
      connectionStatus = STATUS.DISCONNECTED;
      throw err;
    })
    .finally(() => {
      connectPromise = null;
    });

  return connectPromise;
}

async function resetSession() {
  console.log('[wa] Reset session · engine=', ENGINE);
  clearReconnectTimer();
  await destroyBaileys();
  await destroyWweb();
  clearAuthFolder();
  latestQR = '';
  latestPairingCode = '';
  connectionStatus = STATUS.DISCONNECTED;
  await sleep(600);
  await connectWhatsApp();
  return { status: connectionStatus, hasQr: Boolean(latestQR), pairingCode: latestPairingCode || null };
}

async function requestPairingCode(phone) {
  if (ENGINE === 'wwebjs') {
    const error = new Error('Pairing code only works with Baileys engine. Unset WA_ENGINE=wwebjs or use QR at /qr');
    error.statusCode = 400;
    throw error;
  }
  return baileysRequestPairingCode(phone);
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
  if (ENGINE === 'wwebjs') return wwebLookup(phoneNumber);
  return baileysLookup(phoneNumber);
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
    if (typeof onProgress === 'function') onProgress(index + 1, numbersArray.length);
    if (index < numbersArray.length - 1) await sleep(delayMs);
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
