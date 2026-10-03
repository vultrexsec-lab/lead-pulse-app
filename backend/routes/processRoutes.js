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

function getJob(id) {
  return jobs.get(id);
}

function trackProgress(req) {
  const id =
    String(
      req.headers['x-progress-id'] ||
        req.headers['x-process-id'] ||
        req.body?.progressId ||
        newJobId()
    )
      .replace(/[^\w-]/g, '')
      .slice(0, 80) || newJobId();

  jobs.set(id, {
    percent: 0,
    message: 'Starting extraction...',
    jobId: id,
    done: false,
    control: { paused: false, stopped: false },
  });

  const report = (update) => {
    const prev = jobs.get(id) || { control: { paused: false, stopped: false } };
    const next = {
      ...prev,
      ...update,
      jobId: id,
      control: prev.control || { paused: false, stopped: false },
      updatedAt: Date.now(),
    };
    if (update.percent === undefined || update.percent === null) {
      next.percent = prev.percent;
    }
    if (update.message === undefined) {
      next.message = prev.message;
    }
    // keep latest liveLeads/liveCount from update or prev
    if (update.liveLeads === undefined && prev.liveLeads) next.liveLeads = prev.liveLeads;
    if (update.liveCount === undefined && prev.liveCount != null) next.liveCount = prev.liveCount;
    jobs.set(id, next);
  };

  const controlApi = {
    isPaused: () => Boolean(jobs.get(id)?.control?.paused),
    isStopped: () => Boolean(jobs.get(id)?.control?.stopped),
    async waitWhilePaused() {
      while (jobs.get(id)?.control?.paused && !jobs.get(id)?.control?.stopped) {
        await new Promise((r) => setTimeout(r, 400));
      }
    },
  };

  report({ percent: 1, message: 'Starting extraction...' });
  return { id, report, controlApi };
}

function runJob(jobId, report, work) {
  setImmediate(async () => {
    try {
      const result = await work();
      const stopped = Boolean(jobs.get(jobId)?.control?.stopped);
      report({
        percent: 100,
        message: stopped ? 'Stopped — partial results saved' : 'Complete',
        done: true,
        stopped,
        result: {
          success: true,
          downloadUrl: result.downloadUrl,
          total: result.total,
          whatsappCount: result.whatsappCount,
          duplicatesRemoved: result.duplicatesRemoved,
          leads: result.leads,
          partial: stopped,
        },
      });
    } catch (error) {
      const stopped = error.code === 'JOB_STOPPED' || /stopped by user/i.test(error.message || '');
      report({
        percent: 100,
        message: error.message || 'Processing failed',
        done: true,
        error: !stopped,
        stopped,
        result: stopped
          ? error.partialResult || {
              success: true,
              total: 0,
              leads: [],
              message: error.message,
            }
          : {
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
  const { id, report, controlApi } = trackProgress(req);
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'file is required' });
  }
  runJob(id, report, () => processExcelFile(req.file.path, report, controlApi));
  return res.json({
    success: true,
    async: true,
    jobId: id,
    message: 'Job started — use Pause / Stop anytime',
  });
});

router.post('/url', async (req, res) => {
  const { id, report, controlApi } = trackProgress(req);
  if (!req.body?.url) {
    return res.status(400).json({ success: false, message: 'url is required' });
  }
  const url = String(req.body.url);
  runJob(id, report, () => processUrlScrape(url, report, controlApi));
  return res.json({
    success: true,
    async: true,
    jobId: id,
    message: 'Job started — use Pause / Stop anytime',
  });
});

router.post('/keyword', async (req, res) => {
  const { id, report, controlApi } = trackProgress(req);
  if (!req.body?.keyword || !req.body?.country) {
    return res.status(400).json({
      success: false,
      message: 'keyword and country are required',
    });
  }
  runJob(id, report, () =>
    processKeywordScrape(req.body.keyword, req.body.country, report, controlApi)
  );
  return res.json({
    success: true,
    async: true,
    jobId: id,
    message: 'Job started — use Pause / Stop anytime',
  });
});

/** Pause / resume / stop a running job */
router.post('/control/:id', (req, res) => {
  const id = String(req.params.id || '').replace(/[^\w-]/g, '').slice(0, 80);
  const job = jobs.get(id);
  if (!job) {
    return res.status(404).json({ success: false, message: 'Job not found' });
  }
  if (job.done) {
    return res.json({ success: true, message: 'Job already finished', job });
  }

  const action = String(req.body?.action || '').toLowerCase();
  if (!job.control) job.control = { paused: false, stopped: false };

  if (action === 'pause') {
    job.control.paused = true;
    job.message = 'Paused — press Resume to continue';
    jobs.set(id, job);
    return res.json({ success: true, action: 'pause', jobId: id });
  }
  if (action === 'resume') {
    job.control.paused = false;
    job.message = 'Resuming...';
    jobs.set(id, job);
    return res.json({ success: true, action: 'resume', jobId: id });
  }
  if (action === 'stop') {
    job.control.stopped = true;
    job.control.paused = false;
    job.message = 'Stopping — saving collected numbers...';
    jobs.set(id, job);
    return res.json({ success: true, action: 'stop', jobId: id });
  }

  return res.status(400).json({
    success: false,
    message: 'action must be pause, resume, or stop',
  });
});

router.post('/reset-scraped', (req, res) => {
  try {
    const dbPath = path.join(__dirname, '..', 'database', 'scanned_numbers.json');
    const progPath = path.join(__dirname, '..', 'database', 'url_progress.json');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, '{}\n');
    fs.writeFileSync(progPath, '{}\n');
    return res.json({ success: true, message: 'Cleared scraped numbers DB and URL resume state' });
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message });
  }
});

router.get('/progress/:id', (req, res) => {
  const id = String(req.params.id || '').replace(/[^\w-]/g, '').slice(0, 80);
  const job = jobs.get(id);
  if (!job) {
    return res.json({ percent: 0, message: 'Waiting to start...', done: false });
  }
  return res.json({
    ...job,
    paused: Boolean(job.control?.paused),
    stopped: Boolean(job.control?.stopped),
  });
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
