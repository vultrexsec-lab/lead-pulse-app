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
  const qr = typeof whatsappService.getLatestQR === 'function' ? whatsappService.getLatestQR() : '';
  const status = typeof whatsappService.getConnectionStatus === 'function' ? whatsappService.getConnectionStatus() : '';

  if (status === 'CONNECTED') {
    return res.status(200).json({ status: 'connected', message: 'WhatsApp Connected' });
  }

  if (!qr) {
    return res.status(200).json({ status: 'generating', message: 'Generating QR, refresh in 3s' });
  }

  const qrImageUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(qr);
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

app.listen(PORT, function () {
  console.log('Backend running on port ' + PORT);
  if (typeof whatsappService.connectWhatsApp === 'function') {
    whatsappService.connectWhatsApp().catch(function (err) {
      console.error('WhatsApp err:', err.message);
    });
  }
});

module.exports = { app: app, upload: upload };
