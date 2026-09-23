const fs = require('fs');
const path = require('path');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

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
let latestQR = ''; // Stores the raw QR string for Web UI display

function getConnectionStatus() {
  return connectionStatus;
}

function getLatestQR() {
  return latestQR;
}

function formatPhoneNumber(phoneNumber) {
  let digits = String(phoneNumber ?? '').replace(/\D/g, '');

  if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  if (digits.length === 10) {
    digits = `91${digits}`;
  }

  if (!digits) {
    const error = new Error('A valid phone number is required');
    error.statusCode = 400;
    throw error;
  }

  return digits;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function enqueue(task) {
  const run = checkQueue.then(task, task);
  checkQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function connectWhatsApp() {
  if (connectionStatus === STATUS.CONNECTED && sock) {
    return;
  }

  if (connectPromise) {
    return connectPromise;
  }

  connectPromise = openSocket().finally(() => {
    connectPromise = null;
  });

  return connectPromise;
}

async function openSocket() {
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
  } = await import('@whiskeysockets/baileys');

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const socketConfig = {
    auth: state,
    logger: pino({ level: 'silent' }),
  };

  try {
    const { version } = await fetchLatestBaileysVersion();
    socketConfig.version = version;
  } catch (error) {
    console.warn('Using the bundled Baileys version:', error.message);
  }

  const socket = makeWASocket(socketConfig);
  sock = socket;

  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr; // Save raw QR code string
      connectionStatus = STATUS.NEED_QR;
      console.log('WhatsApp authentication required. Scan QR code in browser or terminal:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      latestQR = ''; // Clear QR on successful login
      connectionStatus = STATUS.CONNECTED;
      console.log('WhatsApp connected');
    }

    if (connection === 'close') {
      latestQR = '';
      connectionStatus = STATUS.DISCONNECTED;
      sock = null;

      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(`WhatsApp disconnected (${statusCode ?? 'unknown'})`);

      if (!loggedOut) {
        connectWhatsApp().catch((error) => {
          console.error('WhatsApp reconnect failed:', error.message);
        });
      }
    }
  });
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
  formatPhoneNumber,
  checkNumberStatus,
  checkBulkNumbers,
};
