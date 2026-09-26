/**
 * WhatsApp via whatsapp-web.js
 * Supports local Chrome + Render/serverless via @sparticuz/chromium
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
let initStartedAt = 0;

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

function isRenderLike() {
  return Boolean(
    process.env.RENDER ||
      process.env.RENDER_SERVICE_ID ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.VERCEL ||
      process.env.RAILWAY_ENVIRONMENT
  );
}

async function resolvePuppeteerConfig() {
  // 1) Explicit path
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      headless: true,
    };
  }
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return {
      executablePath: process.env.CHROME_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      headless: true,
    };
  }

  // 2) Render / serverless — @sparticuz/chromium
  if (isRenderLike() || process.env.USE_SPARTICUZ_CHROMIUM === '1') {
    try {
      const chromium = require('@sparticuz/chromium');
      const executablePath = await chromium.executablePath();
      console.log('[wa] Using @sparticuz/chromium for Render/serverless');
      return {
        executablePath,
        args: chromium.args,
        headless: chromium.headless,
        defaultViewport: chromium.defaultViewport,
        ignoreHTTPSErrors: true,
      };
    } catch (e) {
      console.error('[wa] @sparticuz/chromium failed:', e.message);
      lastError = `@sparticuz/chromium missing or failed: ${e.message}. Run: npm install @sparticuz/chromium`;
    }
  }

  // 3) System chrome
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log('[wa] Using system browser', p);
      return {
        executablePath: p,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        headless: true,
      };
    }
  }

  // 4) puppeteer bundled chrome
  try {
    const puppeteer = require('puppeteer');
    if (typeof puppeteer.executablePath === 'function') {
      const ep = puppeteer.executablePath();
      if (ep && fs.existsSync(ep)) {
        console.log('[wa] Using puppeteer chrome', ep);
        return {
          executablePath: ep,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
          headless: true,
        };
      }
    }
  } catch {
    // ignore
  }

  lastError =
    'No Chrome/Chromium found. On Render: npm install @sparticuz/chromium. Local: install Chrome or set PUPPETEER_EXECUTABLE_PATH.';
  console.error('[wa]', lastError);
  return {
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    headless: true,
  };
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
    lastError = 'whatsapp-web.js not installed';
    throw new Error(lastError + '. Run: npm install whatsapp-web.js');
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const puppeteerConfig = await resolvePuppeteerConfig();
  initStartedAt = Date.now();

  const c = new Client({
    authStrategy: new LocalAuth({
      dataPath: AUTH_DIR,
      clientId: 'lead-pulse',
    }),
    puppeteer: {
      ...puppeteerConfig,
      args: [
        ...(puppeteerConfig.args || []),
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--mute-audio',
      ],
    },
    qrMaxRetries: 20,
    authTimeoutMs: 180000,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 15000,
  });

  client = c;

  c.on('qr', (qr) => {
    latestQR = qr;
    connectionStatus = STATUS.NEED_QR;
    lastError = '';
    console.log(
      '[wa] QR ready len=%s after %sms',
      String(qr).length,
      Date.now() - initStartedAt
    );
  });

  c.on('loading_screen', (percent, message) => {
    console.log(`[wa] loading ${percent}% ${message || ''}`);
  });

  c.on('authenticated', () => {
    console.log('[wa] Authenticated');
  });

  c.on('ready', () => {
    latestQR = '';
    connectionStatus = STATUS.CONNECTED;
    lastError = '';
    console.log('[wa] CONNECTED');
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
    setTimeout(() => {
      if (connectionStatus !== STATUS.CONNECTED) {
        connectWhatsApp().catch((e) => console.error('[wa] reconnect:', e.message));
      }
    }, 8000);
  });

  console.log('[wa] initialize whatsapp-web.js...');
  await c.initialize();
  return c;
}

async function requestPairingCode() {
  const error = new Error('Scan QR at /qr (whatsapp-web.js uses official Web login).');
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
    const error = new Error(
      lastError
        ? `WhatsApp not connected: ${lastError}`
        : 'WhatsApp is not connected — open /qr and wait for QR image'
    );
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
  getLastError,
  connectWhatsApp,
  resetSession,
  requestPairingCode,
  formatPhoneNumber,
  checkNumberStatus,
  checkBulkNumbers,
};
