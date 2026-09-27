require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

let QRCode;
try {
  QRCode = require('qrcode');
} catch (e) {
  QRCode = null;
}

const apiRoutes = require('./routes');
const whatsappRoutes = require('./routes/whatsappRoutes');
const scraperRoutes = require('./routes/scraperRoutes');
const processRoutes = require('./routes/processRoutes');
const whatsappService = require('./services/whatsappService');
try { require('./scripts/patch-baileys-pairing').ensurePatched(); } catch (e) { console.warn('[wa] patch', e.message); }


const app = express();
const PORT = process.env.PORT || 5000;
const uploadsDir = path.join(__dirname, 'uploads');

fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (_req, _file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (_req, file, cb) {
    const safeName = file.originalname.replace(/[^\w.\-]+/g, '_');
    cb(null, Date.now() + '-' + safeName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('upload', upload);

const handleQR = async function (req, res) {
  try {
    if (typeof whatsappService.connectWhatsApp === 'function') {
      whatsappService.connectWhatsApp().catch(function () {});
    }
  } catch (e) {}

  const qr = typeof whatsappService.getLatestQR === 'function' ? whatsappService.getLatestQR() : '';
  const status = typeof whatsappService.getConnectionStatus === 'function' ? whatsappService.getConnectionStatus() : '';

  // JSON debug: /qr?format=json or /api/qr?format=json
  if (req.query && req.query.format === 'json') {
    return res.status(200).json({
      status: status,
      hasQr: Boolean(qr),
      qrPreview: qr ? String(qr).slice(0, 80) : null,
      qrLength: qr ? String(qr).length : 0,
      qrStartsWithWaMe: qr ? String(qr).startsWith('https://wa.me/') : false,
    });
  }

  if (status === 'CONNECTED') {
    return res.status(200).json({ status: 'connected', message: 'WhatsApp Connected' });
  }

  if (!qr) {
    var lastErr = typeof whatsappService.getLastError === 'function' ? whatsappService.getLastError() : '';
    return res.status(200).json({
      status: 'generating',
      message: lastErr ? ('QR not ready: ' + lastErr) : 'Generating QR, refresh in 3s (on Render Chrome needs @sparticuz/chromium)',
      lastError: lastErr || null,
      hint: 'Render.com needs @sparticuz/chromium. After deploy wait 30-60s and refresh. Check Render logs for [wa] lines.'
    });
  }

  // Always prefer local PNG — third-party QR APIs can corrupt long Baileys payloads
  if (QRCode) {
    try {
      const png = await QRCode.toBuffer(String(qr), {
        type: 'png',
        width: 400,
        margin: 2,
        errorCorrectionLevel: 'L',
      });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      return res.status(200).send(png);
    } catch (e) {
      console.warn('Local QR render failed:', e.message);
    }
  }

  const qrImageUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=400x400&ecc=L&data=' + encodeURIComponent(String(qr));
  res.setHeader('Cache-Control', 'no-store');
  return res.redirect(qrImageUrl);
};


app.get('/qr', handleQR);
app.get('/api/qr', handleQR);

app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/scraper', scraperRoutes);
app.use('/api/process', processRoutes);
app.use('/api', apiRoutes);

app.use(function (err, _req, res, _next) {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ status: 'error', message: err.message });
  }
  console.error(err);
  return res.status(500).json({ status: 'error', message: 'Internal server error' });
});


app.get('/pair', function (_req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>WhatsApp Pair</title>
  <style>body{font-family:system-ui;background:#0b0f14;color:#e2e8f0;max-width:480px;margin:40px auto;padding:0 16px}
  input,button{font-size:16px;padding:12px;border-radius:10px;border:1px solid #334155;width:100%;box-sizing:border-box;margin:8px 0}
  button{background:#25D366;color:#052e16;font-weight:700;border:0;cursor:pointer}
  code{background:#1e293b;padding:2px 6px;border-radius:4px}
  #out{margin-top:16px;white-space:pre-wrap;background:#111827;padding:12px;border-radius:10px}
  a{color:#4ade80}</style></head><body>
  <h1>WhatsApp link</h1>
  <p>1) Open <a href="/qr" target="_blank">/qr</a> and scan QR<br>
  2) Or enter phone with country code for pairing code</p>
  <input id="phone" placeholder="9198XXXXXXXX" />
  <button id="go">Get pairing code</button>
  <button id="reset" style="background:#64748b;color:#fff">Reset session</button>
  <div id="out"></div>
  <script>
  const out = document.getElementById('out');
  document.getElementById('go').onclick = async () => {
    const phone = document.getElementById('phone').value.trim();
    out.textContent = 'Requesting...';
    try {
      const r = await fetch('/api/whatsapp/pairing-code', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({phone})});
      const j = await r.json();
      out.textContent = JSON.stringify(j, null, 2);
      if (j.pairingCode) out.textContent = 'Code: ' + j.pairingCode + '\n\nPhone: Linked devices → Link with phone number → enter code';
    } catch(e) { out.textContent = e.message; }
  };
  document.getElementById('reset').onclick = async () => {
    out.textContent = 'Resetting...';
    const r = await fetch('/api/whatsapp/reset', {method:'POST'});
    out.textContent = JSON.stringify(await r.json(), null, 2);
  };
  </script></body></html>`);
});

app.listen(PORT, function () {
  console.log('Backend running on port ' + PORT);
  if (typeof whatsappService.connectWhatsApp === 'function') {
    whatsappService.connectWhatsApp().catch(function (err) {
      console.error('WhatsApp err:', err.message);
    });
  }
});

module.exports = { app: app, upload: upload };
