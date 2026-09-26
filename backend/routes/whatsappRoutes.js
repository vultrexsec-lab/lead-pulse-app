const express = require('express');
const {
  getConnectionStatus,
  getLatestQR,
  checkNumberStatus,
  connectWhatsApp,
  resetSession,
} = require('../services/whatsappService');

const router = express.Router();

router.get('/status', (_req, res) => {
  res.json({
    status: getConnectionStatus(),
    hasQr: Boolean(getLatestQR()),
  });
});

router.post('/reset', async (_req, res) => {
  try {
    const result = await resetSession();
    return res.json({
      status: 'ok',
      message: 'Session cleared. Scan the new QR code within 60 seconds.',
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
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to connect',
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
