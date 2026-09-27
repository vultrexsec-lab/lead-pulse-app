const express = require('express');
const {
  getConnectionStatus,
  getLatestQR,
  getLatestPairingCode,
  getLastError,
  getEngine,
  isWhatsAppEnabled,
  checkNumberStatus,
  connectWhatsApp,
  resetSession,
  requestPairingCode,
} = require('../services/whatsappService');
const { isPatched, findBaileysRoot } = require('../scripts/patch-baileys-pairing');

const router = express.Router();

router.get('/status', (_req, res) => {
  let pairingFix = false;
  try {
    const root = findBaileysRoot();
    pairingFix = root ? isPatched(root) : false;
  } catch (_) {}
  const enabled = typeof isWhatsAppEnabled === 'function' ? isWhatsAppEnabled() : false;
  if (!enabled) {
    return res.json({
      status: 'DISABLED',
      whatsappEnabled: false,
      message: 'WhatsApp OFF — scrape numbers without QR. Set WHATSAPP_ENABLED=1 to enable later.',
    });
  }
  res.json({
    whatsappEnabled: true,
    status: getConnectionStatus(),
    hasQr: Boolean(getLatestQR()),
    pairingCode: getLatestPairingCode() || null,
    lastError: typeof getLastError === 'function' ? getLastError() : null,
    engine: typeof getEngine === 'function' ? getEngine() : null,
    pairingFix,
    hint: pairingFix
      ? 'If scan still fails, Render/datacenter IP may be blocked by WhatsApp. Run backend on your PC to link.'
      : 'Pairing patch not applied — restart with npm start',
  });
});

router.post('/reset', async (_req, res) => {
  try {
    const result = await resetSession();
    return res.json({
      status: 'ok',
      message: 'Session cleared. Open /qr and scan the NEW code within 60 seconds.',
      connection: result.status,
      hasQr: result.hasQr,
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to reset session',
    });
  }
});

router.post('/connect', async (_req, res) => {
  try {
    await connectWhatsApp();
    return res.json({
      status: getConnectionStatus(),
      hasQr: Boolean(getLatestQR()),
    pairingCode: getLatestPairingCode() || null,
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to connect',
    });
  }
});

router.post('/pairing-code', async (req, res) => {
  try {
    const phone = req.body?.phone || req.body?.phoneNumber;
    const code = await requestPairingCode(phone);
    return res.json({
      status: 'ok',
      pairingCode: code,
      message: 'In WhatsApp: Linked devices → Link with phone number → enter this code',
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || 'Failed to create pairing code',
    });
  }
});

router.post('/check-single', async (req, res) => {
  try {
    const phoneNumber = req.body?.phoneNumber;

    if (phoneNumber === undefined || phoneNumber === null || phoneNumber === '') {
      return res.status(400).json({
        status: 'error',
        message: 'phoneNumber is required',
      });
    }

    const result = await checkNumberStatus(phoneNumber);
    return res.json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      status: 'error',
      message: error.message || 'Failed to check phone number',
    });
  }
});

module.exports = router;
