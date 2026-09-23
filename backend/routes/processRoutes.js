const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

const {
  processExcelFile,
  processUrlScrape,
  processKeywordScrape,
} = require('../services/pipelineService');
const { UPLOADS_DIR } = require('../utils/excelGenerator');

const router = express.Router();
const jobs = new Map();

function trackProgress(req) {
  const raw = req.get('x-process-id') || crypto.randomUUID();
  const id = String(raw).replace(/[^\w-]/g, '').slice(0, 80) || crypto.randomUUID();
  const report = (update) => {
    jobs.set(id, {
      percent: 0,
      message: 'Starting extraction...',
      ...update,
    });
  };

  report({ percent: 1, message: 'Starting extraction...' });
  return report;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      cb(null, UPLOADS_DIR);
    },
    filename: (_req, file, cb) => {
      const safeName = file.originalname.replace(/[^\w.\-]+/g, '_');
      cb(null, `${Date.now()}-${safeName}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.(xlsx|xls|csv)$/i.test(file.originalname)) {
      cb(null, true);
      return;
    }

    const error = new Error('Only .xlsx, .xls, and .csv files are supported');
    error.statusCode = 400;
    cb(error);
  },
});

function acceptFile(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    res.status(error.statusCode || 400).json({
      success: false,
      message: error.message || 'File upload failed',
    });
  });
}

function sendResult(res, result) {
  res.json({
    success: true,
    downloadUrl: result.downloadUrl,
    total: result.total,
    whatsappCount: result.whatsappCount,
    duplicatesRemoved: result.duplicatesRemoved,
    leads: result.leads,
  });
}

function sendError(res, error) {
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message || 'Processing failed',
  });
}

router.post('/file', acceptFile, async (req, res) => {
  const report = trackProgress(req);
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'file is required' });
    }

    const result = await processExcelFile(req.file.path, report);
    return sendResult(res, result);
  } catch (error) {
    report({ percent: 100, message: error.message || 'Processing failed', error: true });
    return sendError(res, error);
  }
});

router.post('/url', async (req, res) => {
  const report = trackProgress(req);
  try {
    if (!req.body?.url) {
      return res.status(400).json({ success: false, message: 'url is required' });
    }

    const result = await processUrlScrape(req.body.url, report);
    return sendResult(res, result);
  } catch (error) {
    report({ percent: 100, message: error.message || 'Processing failed', error: true });
    return sendError(res, error);
  }
});

router.post('/keyword', async (req, res) => {
  const report = trackProgress(req);
  try {
    if (!req.body?.keyword || !req.body?.country) {
      return res.status(400).json({
        success: false,
        message: 'keyword and country are required',
      });
    }

    const result = await processKeywordScrape(req.body.keyword, req.body.country, report);
    return sendResult(res, result);
  } catch (error) {
    report({ percent: 100, message: error.message || 'Processing failed', error: true });
    return sendError(res, error);
  }
});

router.get('/progress/:id', (req, res) => {
  const id = String(req.params.id || '').replace(/[^\w-]/g, '').slice(0, 80);
  res.json(jobs.get(id) || { percent: 0, message: 'Waiting to start...' });
});

router.get('/download/:filename', (req, res) => {
  const fileName = path.basename(req.params.filename);
  if (!/^[\w.\-]+\.xlsx$/i.test(fileName)) {
    return res.status(400).json({ success: false, message: 'Invalid file name' });
  }

  const root = path.resolve(UPLOADS_DIR);
  const filePath = path.resolve(root, fileName);
  if (path.dirname(filePath) !== root || !fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, message: 'File not found' });
  }

  return res.download(fileName, fileName, { root }, (error) => {
    if (!error || res.headersSent) return;
    res.status(404).json({ success: false, message: 'File not found' });
  });
});

module.exports = router;
