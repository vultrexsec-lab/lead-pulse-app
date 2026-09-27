const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const {
  processExcelFile,
  processUrlScrape,
  processKeywordScrape,
} = require('../services/pipelineService');

const router = express.Router();
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const jobs = new Map();

function newJobId() {
  return crypto.randomBytes(12).toString('hex');
}

function trackProgress(req) {
  const id =
    String(req.headers['x-progress-id'] || req.headers['x-process-id'] || req.body?.progressId || newJobId()).replace(
      /[^\w-]/g,
      ''
    ).slice(0, 80) || newJobId();

  jobs.set(id, { percent: 0, message: 'Starting extraction...', jobId: id });

  const report = (update) => {
    const prev = jobs.get(id) || {};
    jobs.set(id, {
      ...prev,
      ...update,
      jobId: id,
      updatedAt: Date.now(),
    });
  };

  report({ percent: 1, message: 'Starting extraction...' });
  return { id, report };
}

function runJob(jobId, report, work) {
  setImmediate(async () => {
    try {
      const result = await work();
      report({
        percent: 100,
        message: 'Complete',
        done: true,
        result: {
          success: true,
          downloadUrl: result.downloadUrl,
          total: result.total,
          whatsappCount: result.whatsappCount,
          duplicatesRemoved: result.duplicatesRemoved,
          leads: result.leads,
        },
      });
    } catch (error) {
      report({
        percent: 100,
        message: error.message || 'Processing failed',
        done: true,
        error: true,
        result: {
          success: false,
          message: error.message || 'Processing failed',
        },
      });
    }
  });

  return jobId;
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

router.post('/file', acceptFile, async (req, res) => {
  const { id, report } = trackProgress(req);
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'file is required' });
  }
  runJob(id, report, () => processExcelFile(req.file.path, report));
  return res.json({
    success: true,
    async: true,
    jobId: id,
    message: 'Job started — poll /api/process/progress/' + id,
  });
});

router.post('/url', async (req, res) => {
  const { id, report } = trackProgress(req);
  if (!req.body?.url) {
    return res.status(400).json({ success: false, message: 'url is required' });
  }
  const url = String(req.body.url);
  runJob(id, report, () => processUrlScrape(url, report));
  return res.json({
    success: true,
    async: true,
    jobId: id,
    message: 'Job started — poll /api/process/progress/' + id,
  });
});

router.post('/keyword', async (req, res) => {
  const { id, report } = trackProgress(req);
  if (!req.body?.keyword || !req.body?.country) {
    return res.status(400).json({
      success: false,
      message: 'keyword and country are required',
    });
  }
  runJob(id, report, () =>
    processKeywordScrape(req.body.keyword, req.body.country, report)
  );
  return res.json({
    success: true,
    async: true,
    jobId: id,
    message: 'Job started — poll /api/process/progress/' + id,
  });
});

router.get('/progress/:id', (req, res) => {
  const id = String(req.params.id || '').replace(/[^\w-]/g, '').slice(0, 80);
  const job = jobs.get(id);
  if (!job) {
    return res.json({ percent: 0, message: 'Waiting to start...', done: false });
  }
  return res.json(job);
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
