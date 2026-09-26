const fs = require('fs');
const path = require('path');
const pino = require('pino');

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
let reconnectTimer = null;
let intentionalClose = false;

const logger = pino({ level: process.env.WA_LOG_LEVEL || 'silent' });

function getConnectionStatus() {
  return connectionStatus;
}

function getLatestQR() {
  return latestQR;
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
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('creds.update');
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

/**
 * Force a clean new QR session (fixes "Couldn't link device" after bad pairing).
 */
async function resetSession() {
  console.log('[wa] Resetting WhatsApp session...');
  await disconnectSocket();
  clearAuthFolder();
  latestQR = '';
  connectionStatus = STATUS.DISCONNECTED;
  await sleep(500);
  await connectWhatsApp();
  return { status: connectionStatus, hasQr: Boolean(latestQR) };
}

async function connectWhatsApp() {
  if (connectionStatus === STATUS.CONNECTED && sock) return sock;
  if (connectPromise) return connectPromise;

  connectPromise = openSocket()
    .catch((err) => {
      console.error('[wa] openSocket error:', err.message);
      connectionStatus = STATUS.DISCONNECTED;
      scheduleReconnect(4000);
      throw err;
    })
    .finally(() => {
      connectPromise = null;
    });

  return connectPromise;
}

async function openSocket() {
  // Close any previous socket before opening a new one (prevents dual-session link failures)
  if (sock) {
    await disconnectSocket();
    await sleep(400);
  }

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
  } = await import('@whiskeysockets/baileys');

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
    console.log('[wa] Using WA version', version?.join?.('.') || version);
  } catch (error) {
    console.warn('[wa] fetchLatestBaileysVersion failed:', error.message);
  }

  // Desktop-like browser identity — mobile-like strings often cause "Couldn't link device"
  const browser =
    typeof Browsers?.ubuntu === 'function'
      ? Browsers.ubuntu('Chrome')
      : ['Ubuntu', 'Chrome', '22.04.4'];

  const socketConfig = {
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
    keepAliveIntervalMs: 25_000,
    qrTimeout: 60_000,
    printQRInTerminal: false,
    getMessage: async () => undefined,
  };

  if (version) {
    socketConfig.version = version;
  }

  const socket = makeWASocket(socketConfig);
  sock = socket;

  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr, isNewLogin } = update;

    if (qr) {
      latestQR = qr;
      connectionStatus = STATUS.NEED_QR;
      console.log('[wa] New QR generated — scan within ~60s (Linked Devices → Link a device)');
    }

    if (isNewLogin) {
      console.log('[wa] New login detected after QR scan');
    }

    if (connection === 'open') {
      latestQR = '';
      connectionStatus = STATUS.CONNECTED;
      clearReconnectTimer();
      console.log('[wa] WhatsApp connected successfully');
    }

    if (connection === 'connecting') {
      console.log('[wa] Connecting...');
    }

    if (connection === 'close') {
      if (intentionalClose) {
        return;
      }

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errMsg = lastDisconnect?.error?.message || '';
      console.log(`[wa] Disconnected code=${statusCode} msg=${errMsg}`);

      connectionStatus = STATUS.DISCONNECTED;
      sock = null;

      // 401 / loggedOut → bad session, must clear and show new QR
      // 515 → restart required right after successful pairing (do NOT clear auth)
      // 440 → conflict / replaced
      // 408 / 428 → timeout

      const loggedOut =
        statusCode === DisconnectReason.loggedOut ||
        statusCode === 401 ||
        statusCode === 403;

      const restartRequired =
        statusCode === DisconnectReason.restartRequired ||
        statusCode === 515;

      if (loggedOut) {
        latestQR = '';
        clearAuthFolder();
        scheduleReconnect(1500);
        return;
      }

      if (restartRequired) {
        // Pairing succeeded — reopen with saved creds (do not wipe auth)
        console.log('[wa] Restart required after link — reconnecting with saved session');
        scheduleReconnect(1000);
        return;
      }

      // Keep existing QR if still valid; reconnect for a fresh one if needed
      scheduleReconnect(3000);
    }
  });

  return socket;
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
  connectWhatsApp,
  resetSession,
  formatPhoneNumber,
  checkNumberStatus,
  checkBulkNumbers,
};
