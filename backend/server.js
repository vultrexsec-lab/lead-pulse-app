require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const QRCode = require('qrcode');

const apiRoutes = require('./routes');
const whatsappRoutes = require('./routes/whatsappRoutes');
const scraperRoutes = require('./routes/scraperRoutes');
const processRoutes = require('./routes/processRoutes');
const { connectWhatsApp, getLatestQR, getConnectionStatus } = require('./services/whatsappService');

const app = express();
const PORT = process.env.PORT || 5000;
const uploadsDir = path.join(__dirname, 'uploads');

fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^\w.\-]+/g, '_');
    cb(null, `\({Date.now()}-\){safeName}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('upload', upload);

// Web QR Code Route for direct browser scanning
app.get('/qr', async (req, res) => {
  const qr = getLatestQR ? getLatestQR() : '';
  const status = getConnectionStatus ? getConnectionStatus() : '';

  if (status === 'CONNECTED') {
    return res.send(`
