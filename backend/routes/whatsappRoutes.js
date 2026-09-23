const express = require('express');
const {
  getConnectionStatus,
  checkNumberStatus,
} = require('../services/whatsappService');

const router = express.Router();

router.get('/status', (_req, res) => {
  res.json({ status: getConnectionStatus() });
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
