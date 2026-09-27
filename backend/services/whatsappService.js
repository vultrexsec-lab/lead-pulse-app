/**
 * Dual engine:
 * - Render / no-Chrome → Baileys (WebSocket only, QR works on Render)
 * - Local with Chrome → whatsapp-web.js (closest to official Web)
 *
 * Override: WA_ENGINE=baileys | wwebjs
 */
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const axios = require('axios');

const AUTH_BAILEYS = path.join(__dirname, '..', 'auth_info_baileys');
const AUTH_WWEBJS = path.join(__dirname, '..', 'auth_info_wwebjs');

const STATUS = {
  CONNECTED: 'CONNECTED',
  DISCONNECTED: 'DISCONNECTED',
  NEED_QR: 'NEED_QR',
};

let engine = null; // 'baileys' | 'wwebjs'
let sock = null;
let wwebClient = null;
let connectionStatus = STATUS.DISCONNECTED;
let connectPromise = null;
let checkQueue = Promise.resolve();
let latestQR = '';
let latestPairingCode = '';
let lastError = '';
let reconnectTimer = null;
let intentionalClose = false;

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });

function isRenderLike() {
  return Boolean(
    process.env.RENDER ||
      process.env.RENDER_SERVICE_ID ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.RAILWAY_ENVIRONMENT
  );
}

function pickEngine() {
  const forced = String(process.env.WA_ENGINE || '').toLowerCase();
  if (forced === 'baileys' || forced === 'wwebjs') return forced;
  // Local PC: real Chrome (same as web.whatsapp.com) — Baileys QR often fails even on residential
  // Render/cloud: no Chrome → Baileys
  if (isRenderLike()) return 'baileys';
  return 'wwebjs';
}

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
function getEngine() {
  return engine || pickEngine();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  } catch (e) {
    console.error('[wa] clear', dir, e.message);
  }
}

function clearAuthFolder() {
  clearDir(AUTH_BAILEYS);
  clearDir(AUTH_WWEBJS);
  clearDir(path.join(__dirname, '..', '.wwebjs_auth'));
  clearDir(path.join(__dirname, '..', '.wwebjs_cache'));
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(ms = 3000) {
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWhatsApp().catch((e) => console.error('[wa] reconnect', e.message));
  }, ms);
}

// ── Baileys ──────────────────────────────────────────────────────────────────

async function resolveWaVersion(mod) {
  if (typeof mod.fetchLatestWaWebVersion === 'function') {
    try {
      const r = await mod.fetchLatestWaWebVersion();
      if (r?.version) {
        console.log('[wa] version WaWeb', r.version.join('.'));
        return r.version;
      }
    } catch (e) {
      console.warn('[wa] WaWeb version', e.message);
    }
  }
  if (typeof mod.fetchLatestBaileysVersion === 'function') {
    try {
      const r = await mod.fetchLatestBaileysVersion();
      if (r?.version) {
        console.log('[wa] version Baileys', r.version.join('.'));
        return r.version;
      }
    } catch (e) {
      console.warn('[wa] Baileys version', e.message);
    }
  }
  try {
    const { data } = await axios.get('https://web.whatsapp.com/sw.js', {
      timeout: 10000,
      responseType: 'text',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      },
    });
    const m = String(data).match(/client_revision["'\s:=]+(\d{8,})/i);
    if (m) {
      const v = [2, 3000, Number(m[1])];
      console.log('[wa] version sw.js', v.join('.'));
      return v;
    }
  } catch (e) {
    console.warn('[wa] sw.js', e.message);
  }
  return [2, 3000, 1023223821];
}

function ensureBaileysPatched() {
  try {
    const patch = require('../scripts/patch-baileys-pairing');
    if (typeof patch.ensurePatched === 'function') {
      const ok = patch.ensurePatched();
      console.log('[wa] baileys patch', ok ? 'OK' : 'FAILED');
      if (!ok) lastError = 'Baileys pairing patch missing — QR scan will fail with Could not link device';
      return ok;
    }
  } catch (e) {
    console.warn('[wa] patch script', e.message);
  }
  return false;
}

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
  ensureBaileysPatched();
  await destroyBaileys();
  await sleep(300);

  let mod;
  try {
    mod = await import('baileys');
  } catch {
    mod = await import('@whiskeysockets/baileys');
  }

  const makeWASocket = mod.default || mod.makeWASocket;
  const {
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    Browsers,
  } = mod;

  fs.mkdirSync(AUTH_BAILEYS, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_BAILEYS);
  const version = await resolveWaVersion(mod);
  const browser =
    typeof Browsers?.macOS === 'function'
      ? Browsers.macOS('Desktop')
      : ['Mac OS', 'Chrome', '14.4.1'];

  console.log('[wa] Baileys start version=', version.join('.'));

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
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    qrTimeout: 60000,
    getMessage: async () => undefined,
  });

  sock = socket;
  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    if (qr) {
      latestQR = qr;
      connectionStatus = STATUS.NEED_QR;
      lastError = '';
      console.log(
        '[wa] QR ready (Baileys) len=%s waMe=%s',
        String(qr).length,
        String(qr).startsWith('https://wa.me/')
      );
    }

    if (isNewLogin) console.log('[wa] isNewLogin');

    if (connection === 'open') {
      latestQR = '';
      connectionStatus = STATUS.CONNECTED;
      lastError = '';
      clearReconnectTimer();
      console.log('[wa] CONNECTED (Baileys)');
    }

    if (connection === 'close') {
      if (intentionalClose) return;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('[wa] close', code, lastDisconnect?.error?.message || '');
      connectionStatus = STATUS.DISCONNECTED;
      sock = null;

      const loggedOut = code === DisconnectReason?.loggedOut || code === 401 || code === 403;
      const restart = code === DisconnectReason?.restartRequired || code === 515;

      if (loggedOut) {
        latestQR = '';
        clearDir(AUTH_BAILEYS);
        scheduleReconnect(1500);
        return;
      }
      if (restart) {
        scheduleReconnect(1000);
        return;
      }
      scheduleReconnect(3000);
    }
  });

  return socket;
}

// ── wwebjs ───────────────────────────────────────────────────────────────────

async function destroyWweb() {
  if (!wwebClient) return;
  const c = wwebClient;
  wwebClient = null;
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

async function openWwebjs() {
  await destroyWweb();
  const { Client, LocalAuth } = require('whatsapp-web.js');
  fs.mkdirSync(AUTH_WWEBJS, { recursive: true });

  let executablePath;
  let args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  } else {
    try {
      const chromium = require('@sparticuz/chromium');
      executablePath = await chromium.executablePath();
      args = chromium.args || args;
      console.log('[wa] @sparticuz/chromium');
    } catch {
      try {
        const puppeteer = require('puppeteer');
        executablePath = puppeteer.executablePath();
      } catch {
        // none
      }
    }
  }

  if (!executablePath) {
    lastError = 'No Chrome for wwebjs. On Render set WA_ENGINE=baileys (default).';
    throw new Error(lastError);
  }

  console.log('[wa] wwebjs chrome', executablePath);
  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_WWEBJS, clientId: 'lead-pulse' }),
    puppeteer: { executablePath, args, headless: true },
    qrMaxRetries: 15,
    authTimeoutMs: 120000,
  });
  wwebClient = c;

  c.on('qr', (qr) => {
    latestQR = qr;
    connectionStatus = STATUS.NEED_QR;
    lastError = '';
    console.log('[wa] QR ready (wwebjs) len=', String(qr).length);
  });
  c.on('ready', () => {
    latestQR = '';
    connectionStatus = STATUS.CONNECTED;
    console.log('[wa] CONNECTED (wwebjs)');
  });
  c.on('auth_failure', (msg) => {
    lastError = String(msg);
    connectionStatus = STATUS.DISCONNECTED;
  });
  c.on('disconnected', () => {
    connectionStatus = STATUS.DISCONNECTED;
    scheduleReconnect(5000);
  });

  await c.initialize();
  return c;
}

// ── Public ───────────────────────────────────────────────────────────────────

async function connectWhatsApp() {
  if (connectionStatus === STATUS.CONNECTED && (sock || wwebClient)) {
    return sock || wwebClient;
  }
  if (connectPromise) return connectPromise;

  engine = pickEngine();
  console.log('[wa] engine=', engine, 'render=', isRenderLike());
  if (engine === 'wwebjs') {
    console.log('[wa] IMPORTANT: Using real Chrome (like web.whatsapp.com). Keep /qr open and scan once.');
  } else {
    console.log('[wa] Baileys mode (cloud). If link fails on local, set WA_ENGINE=wwebjs');
  }

  connectPromise = (async () => {
    if (engine === 'wwebjs') return openWwebjs();
    return openBaileys();
  })()
    .catch((err) => {
      lastError = err.message;
      console.error('[wa] connect error', err.message);
      connectionStatus = STATUS.DISCONNECTED;
      // If wwebjs fails on Render, auto-fallback to Baileys once
      if (engine === 'wwebjs') {
        console.log('[wa] fallback → Baileys');
        engine = 'baileys';
        return openBaileys();
      }
      throw err;
    })
    .finally(() => {
      connectPromise = null;
    });

  return connectPromise;
}

async function resetSession() {
  console.log('[wa] reset');
  clearReconnectTimer();
  await destroyBaileys();
  await destroyWweb();
  clearAuthFolder();
  latestQR = '';
  lastError = '';
  connectionStatus = STATUS.DISCONNECTED;
  connectPromise = null;
  await sleep(500);
  await connectWhatsApp();
  return {
    status: connectionStatus,
    hasQr: Boolean(latestQR),
    engine: getEngine(),
    lastError: lastError || null,
  };
}

async function requestPairingCode(phone) {
  if (getEngine() !== 'baileys' || !sock?.requestPairingCode) {
    const error = new Error('Pairing code only with Baileys. QR: open /qr');
    error.statusCode = 400;
    throw error;
  }
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) {
    const error = new Error('phone with country code required');
    error.statusCode = 400;
    throw error;
  }
  const code = await sock.requestPairingCode(digits);
  latestPairingCode = code;
  connectionStatus = STATUS.NEED_QR;
  return code;
}

function formatPhoneNumber(phoneNumber) {
  let digits = String(phoneNumber ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10 && /^(69|2)\d{8}$/.test(digits)) digits = `30${digits}`;
  else if (digits.length === 10 && /^[6-9]/.test(digits)) digits = `91${digits}`;
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
  if (connectionStatus !== STATUS.CONNECTED) {
    const error = new Error(lastError || 'WhatsApp is not connected — open /qr');
    error.statusCode = 503;
    throw error;
  }
  const normalized = formatPhoneNumber(phoneNumber);

  if (engine === 'wwebjs' && wwebClient) {
    const chatId = `${normalized}@c.us`;
    let exists = false;
    try {
      exists =
        typeof wwebClient.isRegisteredUser === 'function'
          ? Boolean(await wwebClient.isRegisteredUser(chatId))
          : Boolean(await wwebClient.getNumberId(chatId));
    } catch {
      exists = false;
    }
    return { phoneNumber: normalized, exists, jid: exists ? chatId : null };
  }

  if (!sock) {
    const error = new Error('WhatsApp socket missing');
    error.statusCode = 503;
    throw error;
  }
  const results = await sock.onWhatsApp(normalized);
  const match = Array.isArray(results) ? results.find((i) => i?.exists) : null;
  return {
    phoneNumber: normalized,
    exists: Boolean(match?.exists),
    jid: match?.jid ?? null,
  };
}

async function checkBulkNumbers(numbersArray, delayMs = 1200, onProgress) {
  if (!Array.isArray(numbersArray)) {
    const error = new Error('numbersArray must be an array');
    error.statusCode = 400;
    throw error;
  }
  const results = [];
  for (let i = 0; i < numbersArray.length; i += 1) {
    results.push(await checkNumberStatus(numbersArray[i]));
    if (typeof onProgress === 'function') onProgress(i + 1, numbersArray.length);
    if (i < numbersArray.length - 1) await sleep(delayMs);
  }
  return results;
}

module.exports = {
  STATUS,
  getConnectionStatus,
  getLatestQR,
  getLatestPairingCode,
  getLastError,
  getEngine,
  connectWhatsApp,
  resetSession,
  requestPairingCode,
  formatPhoneNumber,
  checkNumberStatus,
  checkBulkNumbers,
};
