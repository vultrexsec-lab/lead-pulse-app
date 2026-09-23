require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');

const apiRoutes = require('./routes');
const whatsappRoutes = require('./routes/whatsappRoutes');
const scraperRoutes = require('./routes/scraperRoutes');
const processRoutes = require('./routes/processRoutes');
const { connectWhatsApp } = require('./services/whatsappService');

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
    cb(null, `${Date.now()}-${safeName}`);
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

app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/scraper', scraperRoutes);
app.use('/api/process', processRoutes);
app.use('/api', apiRoutes);

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ status: 'error', message: err.message });
  }

  console.error(err);
  return res.status(500).json({ status: 'error', message: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  connectWhatsApp().catch((error) => {
    console.error('Failed to start WhatsApp connection:', error.message);
  });
});

module.exports = { app, upload };
