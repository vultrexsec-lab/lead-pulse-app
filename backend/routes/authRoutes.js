const express = require('express');
const { loginHandler, verifyToken } = require('../middleware/auth');

const router = express.Router();

router.post('/login', loginHandler);

router.get('/me', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!verifyToken(token)) {
    return res.status(401).json({ success: false, authenticated: false });
  }
  return res.json({ success: true, authenticated: true });
});

module.exports = router;
