const crypto = require('crypto');

const DEFAULT_USER = 'leadpulse_admin';
const DEFAULT_PASS = 'Lp#9kR2mQx7vN4w$Kp';

function getCredentials() {
  return {
    username: process.env.APP_USERNAME || DEFAULT_USER,
    password: process.env.APP_PASSWORD || DEFAULT_PASS,
  };
}

function getAuthSecret() {
  return process.env.AUTH_SECRET || process.env.APP_PASSWORD || DEFAULT_PASS;
}

function issueToken(username) {
  const secret = getAuthSecret();
  const payload = username + ':' + Date.now();
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(payload + ':' + sig).toString('base64url');
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const parts = raw.split(':');
    if (parts.length < 3) return false;
    const username = parts[0];
    const ts = parts[1];
    const sig = parts.slice(2).join(':');
    const secret = getAuthSecret();
    const expected = crypto
      .createHmac('sha256', secret)
      .update(username + ':' + ts)
      .digest('hex');
    if (sig.length !== expected.length) return false;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const age = Date.now() - Number(ts);
    if (!Number.isFinite(age) || age < 0 || age > 30 * 24 * 60 * 60 * 1000) return false;
    return username === getCredentials().username;
  } catch {
    return false;
  }
}

function loginHandler(req, res) {
  const username = String((req.body && req.body.username) || '');
  const password = String((req.body && req.body.password) || '');
  const creds = getCredentials();
  if (username !== creds.username || password !== creds.password) {
    return res.status(401).json({ success: false, message: 'Invalid username or password' });
  }
  const token = issueToken(creds.username);
  return res.json({ success: true, token: token, username: creds.username });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : String(req.headers['x-auth-token'] || req.query.token || '').trim();
  if (!verifyToken(token)) {
    return res.status(401).json({ success: false, message: 'Unauthorized — please login' });
  }
  return next();
}

module.exports = {
  getCredentials: getCredentials,
  issueToken: issueToken,
  verifyToken: verifyToken,
  loginHandler: loginHandler,
  requireAuth: requireAuth,
};
