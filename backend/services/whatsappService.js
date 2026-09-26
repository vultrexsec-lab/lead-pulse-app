const fs = require('fs');
const path = require('path');
const pino = require('pino');
const axios = require('axios');

const AUTH_DIR = path.join(__dirname, '..', 'auth_info_baileys');

const STATUS = {
  CONNECTED: 'CONNECTED',
  DISCONNECTED: 'DISCONNECTED',
  NEED_QR: 'NEED_QR',
};

let sock = null;
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

function clearAuthFolder() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('[wa] Cleared session directory');
    }
  } catch (err) {
    console.error('[wa] Auth dir cleanup error:', err.message);
  }
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

async function disconnectSocket() {
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

async function resetSession() {
  console.log('[wa] Resetting WhatsApp session...');
  await disconnectSocket();
  clearAuthFolder();
  latestQR = '';
  latestPairingCode = '';
  connectionStatus = STATUS.DISCONNECTED;
  await sleep(800);
  await connectWhatsApp();
  return {
    status: connectionStatus,
    hasQr: Boolean(latestQR),
    pairingCode: latestPairingCode || null,
  };
}

/**
 * Resolve a current WhatsApp Web client version.
 * Stale versions are a common cause of "Couldn't link device".
 */
async function resolveWaVersion(baileysMod) {
  // 1) Official helper when present (Baileys 6.7+ / 7.x)
  if (typeof baileysMod.fetchLatestWaWebVersion === 'function') {
    try {
      const r = await baileysMod.fetchLatestWaWebVersion();
      if (r?.version) {
        console.log('[wa] version via fetchLatestWaWebVersion:', r.version.join('.'));
        return r.version;
      }
    } catch (e) {
      console.warn('[wa] fetchLatestWaWebVersion failed:', e.message);
    }
  }

  // 2) Baileys cache helper (often stale — use last)
  let baileysVersion = null;
  if (typeof baileysMod.fetchLatestBaileysVersion === 'function') {
    try {
      const r = await baileysMod.fetchLatestBaileysVersion();
      if (r?.version) baileysVersion = r.version;
    } catch (e) {
      console.warn('[wa] fetchLatestBaileysVersion failed:', e.message);
    }
  }

  // 3) Scrape live revision from web.whatsapp.com
  try {
    const { data } = await axios.get('https://web.whatsapp.com/', {
      timeout: 12000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const html = String(data || '');
    // common patterns in WA web HTML / bootstrap
    const patterns = [
      /\"client_revision\"\s*:\s*(\d+)/i,
      /client_revision[\"'\s:=]+(\d{8,})/i,
      /\"version\"\s*:\s*\"(\d+)\.(\d+)\.(\d+)\"/,
      /\"appVersion\"\s*:\s*\"(\d+)\.(\d+)\.(\d+)\"/,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1] && m[2] && m[3]) {
        const version = [Number(m[1]), Number(m[2]), Number(m[3])];
        console.log('[wa] version via web.whatsapp.com HTML:', version.join('.'));
        return version;
      }
      if (m && m[1] && !m[2]) {
        // client_revision style → map to [2, 3000, revision]
        const revision = Number(m[1]);
        if (Number.isFinite(revision) && revision > 1000000) {
          const version = [2, 3000, revision];
          console.log('[wa] version via client_revision:', version.join('.'));
          return version;
        }
      }
    }
  } catch (e) {
    console.warn('[wa] web.whatsapp.com version scrape failed:', e.message);
  }

  if (baileysVersion) {
    console.log('[wa] fallback baileys version:', baileysVersion.join('.'));
    return baileysVersion;
  }

  // Last-resort known-good shape (may still be rejected if too old)
  console.warn('[wa] using hardcoded fallback version');
  return [2, 3000, 1023223821];
}

async function connectWhatsApp() {
  if (connectionStatus === STATUS.CONNECTED && sock) return sock;
  if (connectPromise) return connectPromise;

  connectPromise = openSocket()
    .catch((err) => {
      console.error('[wa] openSocket error:', err.message);
      connectionStatus = STATUS.DISCONNECTED;
      scheduleReconnect(5000);
      throw err;
    })
    .finally(() => {
      connectPromise = null;
    });

  return connectPromise;
}

async function openSocket() {
  if (sock) {
    await disconnectSocket();
    await sleep(500);
  }

  const baileysMod = await import('@whiskeysockets/baileys');
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    Browsers,
  } = baileysMod;

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const version = await resolveWaVersion(baileysMod);

  // Use a real desktop browser fingerprint (custom labels often fail companion_hello)
  const browser =
    typeof Browsers?.macOS === 'function'
      ? Browsers.macOS('Desktop')
      : typeof Browsers?.ubuntu === 'function'
        ? Browsers.ubuntu('Chrome')
        : ['Mac OS', 'Chrome', '14.4.1'];

  const socketConfig = {
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
  };

  console.log('[wa] opening socket browser=', JSON.stringify(browser), 'version=', version?.join?.('.') || version);

  const socket = makeWASocket(socketConfig);
  sock = socket;

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    if (qr) {
      latestQR = qr;
      connectionStatus = STATUS.NEED_QR;
      console.log('[wa] QR ready — open /qr and scan within ~60s (Linked devices → Link a device)');
    }

    if (isNewLogin) {
      console.log('[wa] isNewLogin=true (pairing progressing)');
    }

    if (connection === 'open') {
      latestQR = '';
      latestPairingCode = '';
      connectionStatus = STATUS.CONNECTED;
      clearReconnectTimer();
      console.log('[wa] CONNECTED');
    }

    if (connection === 'close') {
      if (intentionalClose) return;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errMsg = lastDisconnect?.error?.message || '';
      console.log(`[wa] close code=${statusCode} msg=${errMsg}`);

      connectionStatus = STATUS.DISCONNECTED;
      sock = null;

      const loggedOut =
        statusCode === DisconnectReason.loggedOut ||
        statusCode === 401 ||
        statusCode === 403;

      const restartRequired =
        statusCode === DisconnectReason.restartRequired || statusCode === 515;

      if (loggedOut) {
        latestQR = '';
        latestPairingCode = '';
        clearAuthFolder();
        scheduleReconnect(1500);
        return;
      }

      if (restartRequired) {
        // Expected right after successful QR pair — reconnect with same auth folder
        console.log('[wa] restartRequired (515) — reconnecting with saved creds');
        scheduleReconnect(1200);
        return;
      }

      scheduleReconnect(3000);
    }
  });

  return socket;
}

/**
 * Alternative to QR: 8-digit pairing code (Linked devices → Link with phone number).
 * phone: digits only with country code, e.g. 9198XXXXXXXX
 */
async function requestPairingCode(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) {
    const error = new Error('Phone with country code required, e.g. 919876543210');
    error.statusCode = 400;
    throw error;
  }

  if (!sock) {
    await connectWhatsApp();
    await sleep(2000);
  }
  if (!sock || typeof sock.requestPairingCode !== 'function') {
    const error = new Error('WhatsApp socket not ready for pairing code');
    error.statusCode = 503;
    throw error;
  }

  const code = await sock.requestPairingCode(digits);
  latestPairingCode = code;
  connectionStatus = STATUS.NEED_QR;
  console.log('[wa] pairing code:', code);
  return code;
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

async function checkBulkNumbers(numbersArray, delayMs = 1500, onProgress) {
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
