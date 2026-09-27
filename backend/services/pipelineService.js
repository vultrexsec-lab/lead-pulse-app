const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');

const whatsappService = require('./whatsappService');
const { scrapeUrl, scrapeByKeywordAndCountry } = require('./scraperService');
const { generateExcel } = require('../utils/excelGenerator');

const NAME_ALIASES = [
  'name',
  'full name',
  'contact name',
  'business',
  'business name',
  'company',
  'company name',
  'lead',
  'lead name',
];

const PHONE_ALIASES = [
  'phone',
  'phone number',
  'mobile',
  'mobile number',
  'number',
  'contact',
  'contact number',
  'whatsapp',
  'whatsapp number',
  'tel',
  'telephone',
  'cell',
];

const SOURCE_ALIASES = [
  'source',
  'source url',
  'url',
  'website',
  'website url',
  'link',
  'page',
];

const DATABASE_PATH = path.join(__dirname, '..', 'database', 'scanned_numbers.json');
let databaseQueue = Promise.resolve();

function readScannedNumbers() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATABASE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeScannedNumbers(database) {
  fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
  fs.writeFileSync(DATABASE_PATH, `${JSON.stringify(database, null, 2)}\n`);
}

function withDatabase(task) {
  const run = databaseQueue.then(async () => {
    const database = readScannedNumbers();
    const result = await task(database);
    writeScannedNumbers(database);
    return result;
  });

  databaseQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeHeader(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && value.text) return String(value.text).trim();
  if (typeof value === 'object' && value.result !== undefined) return cellText(value.result);
  return String(value).trim();
}

function looksLikePhone(value) {
  const digits = cellText(value).replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

function sheetToMatrix(worksheet) {
  const matrix = [];
  if (!worksheet) return matrix;

  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    matrix.push(values.map((value) => cellText(value)));
  });

  return matrix;
}

async function readMatrix(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === '.csv') {
    const workbook = new ExcelJS.Workbook();
    await workbook.csv.readFile(filePath);
    return sheetToMatrix(workbook.worksheets[0]);
  }

  if (extension === '.xls') {
    const book = XLSX.readFile(filePath);
    const sheet = book.Sheets[book.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    return rows.map((row) => row.map((value) => cellText(value)));
  }

  if (extension === '.xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    return sheetToMatrix(workbook.worksheets[0]);
  }

  throw httpError('Upload an .xlsx, .xls, or .csv file', 400);
}

function findAliasColumn(headers, aliases) {
  return headers.findIndex((header) => aliases.includes(normalizeHeader(header)));
}

function detectPhoneColumn(rows) {
  const width = Math.max(...rows.map((row) => row.length), 0);
  let bestIndex = -1;
  let bestScore = 0;

  for (let index = 0; index < width; index += 1) {
    const score = rows.reduce((count, row) => count + (looksLikePhone(row[index]) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return bestScore > 0 ? bestIndex : -1;
}

function leadsFromMatrix(matrix) {
  const rows = matrix.filter((row) => row.some((cell) => cellText(cell)));
  if (rows.length === 0) {
    throw httpError('The uploaded file is empty', 400);
  }

  const headerCandidate = rows[0].map((cell) => cellText(cell));
  const hasHeader = headerCandidate.some((cell) => {
    const header = normalizeHeader(cell);
    return NAME_ALIASES.includes(header) || PHONE_ALIASES.includes(header) || SOURCE_ALIASES.includes(header);
  });

  const headers = hasHeader ? headerCandidate : [];
  const dataRows = hasHeader ? rows.slice(1) : rows;
  let phoneIndex = hasHeader ? findAliasColumn(headers, PHONE_ALIASES) : -1;

  if (phoneIndex === -1) {
    phoneIndex = detectPhoneColumn(dataRows);
  }

  if (phoneIndex === -1) {
    throw httpError('Could not find a phone number column', 400);
  }

  let nameIndex = hasHeader ? findAliasColumn(headers, NAME_ALIASES) : -1;
  if (nameIndex === -1) {
    nameIndex = dataRows[0]
      ? dataRows[0].findIndex((_, index) => index !== phoneIndex && !looksLikePhone(dataRows[0][index]))
      : -1;
  }

  const sourceIndex = hasHeader ? findAliasColumn(headers, SOURCE_ALIASES) : -1;
  const used = new Set([phoneIndex, nameIndex, sourceIndex].filter((index) => index >= 0));
  const leads = [];

  for (const row of dataRows) {
    const number = cellText(row[phoneIndex]);
    if (!number) continue;

    const extra = {};
    headers.forEach((header, index) => {
      if (used.has(index) || !header) return;
      extra[header] = cellText(row[index]);
    });

    leads.push({
      name: nameIndex >= 0 ? cellText(row[nameIndex]) : '',
      number,
      source: sourceIndex >= 0 ? cellText(row[sourceIndex]) : '',
      extra,
    });
  }

  if (leads.length === 0) {
    throw httpError('No phone numbers were found in the file', 400);
  }

  return leads;
}

function selectNewLeads(leads, database) {
  const seen = new Set();
  const fresh = [];
  let duplicatesRemoved = 0;

  for (const lead of leads) {
    let number;
    try {
      number = whatsappService.formatPhoneNumber(lead.number);
    } catch {
      continue;
    }

    if (database[number] || seen.has(number)) {
      duplicatesRemoved += 1;
      continue;
    }

    seen.add(number);
    fresh.push({ ...lead, number });
  }

  return { fresh, duplicatesRemoved };
}

async function enrichWithWhatsApp(leads, onProgress = () => {}) {
  onProgress({
    percent: 8,
    message: 'Removing previously scanned duplicates...',
  });

  const selected = await withDatabase(async (database) => selectNewLeads(leads, database));
  const { fresh, duplicatesRemoved } = selected;

  let checks = [];
  // WhatsApp temporarily OFF by default — set WHATSAPP_ENABLED=1 to turn on later
  const waEnabled =
    process.env.WHATSAPP_ENABLED === '1' || process.env.WHATSAPP_ENABLED === 'true';
  const skipWa =
    !waEnabled ||
    process.env.SKIP_WHATSAPP === '1' ||
    process.env.SKIP_WHATSAPP === 'true' ||
    (typeof whatsappService.getConnectionStatus === 'function' &&
      whatsappService.getConnectionStatus() !== 'CONNECTED');

  if (fresh.length > 0 && skipWa) {
    onProgress({
      percent: 90,
      message:
        'WhatsApp OFF — numbers only (no WA check). Set WHATSAPP_ENABLED=1 later to enable.',
    });
    checks = fresh.map((lead) => ({
      phoneNumber: lead.number,
      exists: null,
      jid: null,
      skipped: true,
    }));
  } else if (fresh.length > 0) {
    onProgress({
      percent: 12,
      message: `Checking 0/${fresh.length} new numbers...`,
      current: 0,
      total: fresh.length,
    });

    checks = await whatsappService.checkBulkNumbers(
        fresh.map((lead) => lead.number),
        1500,
        (current, total) => {
          onProgress({
            percent: 12 + Math.round((current / total) * 80),
            message: `Checking ${current}/${total} new numbers...`,
            current,
            total,
          });
        }
      );
  }

  const rows = fresh.map((lead, index) => {
    const check = checks[index] || {};
    return {
      ...(lead.extra || {}),
      name: lead.name || '',
      number: check.phoneNumber || lead.number,
      source: lead.source || '',
      isWhatsApp: Boolean(check.exists),
      whatsappJid: check.jid || '',
    };
  });

  if (rows.length > 0) {
    const scannedAt = new Date().toISOString();
    await withDatabase(async (database) => {
      for (const row of rows) {
        if (database[row.number]) continue;
        database[row.number] = {
          isWhatsApp: row.isWhatsApp,
          whatsappJid: row.whatsappJid || null,
          firstScannedAt: scannedAt,
        };
      }
    });
  }

  return { rows, duplicatesRemoved };
}

function summarize(rows, file, duplicatesRemoved) {
  return {
    downloadUrl: file.downloadUrl,
    filePath: file.filePath,
    total: rows.length,
    whatsappCount: rows.filter((row) => row.isWhatsApp).length,
    duplicatesRemoved,
    leads: rows.map((row) => ({
      name: row.name,
      number: row.number,
      source: row.source,
      isWhatsApp: row.isWhatsApp,
    })),
  };
}

async function processExcelFile(filePath, onProgress = () => {}) {
  if (!filePath) {
    throw httpError('An Excel or CSV file is required', 400);
  }

  onProgress({ percent: 4, message: 'Reading uploaded file...' });
  const matrix = await readMatrix(filePath);
  const leads = leadsFromMatrix(matrix);
  const { rows, duplicatesRemoved } = await enrichWithWhatsApp(leads, onProgress);
  onProgress({ percent: 96, message: 'Building Excel sheet...' });
  const file = await generateExcel(rows, `validated-leads-${Date.now()}.xlsx`);
  onProgress({ percent: 100, message: 'Verification complete' });
  return summarize(rows, file, duplicatesRemoved);
}

async function processUrlScrape(url, onProgress = () => {}) {
  onProgress({ percent: 4, message: 'Scraping website pages...' });
  const leads = await scrapeUrl(url, onProgress);
  const normalized = leads.map((lead) => ({
    name: lead.name,
    number: lead.number,
    source: lead.sourceUrl || url,
  }));
  if (!normalized.length) {
    onProgress({ percent: 100, message: 'No phone numbers found on this URL' });
    const file = await generateExcel([], `url-leads-${Date.now()}.xlsx`);
    return summarize([], file, 0);
  }
  onProgress({ percent: 84, message: `Scraped ${normalized.length} numbers. Verifying WhatsApp...` });
  const { rows, duplicatesRemoved } = await enrichWithWhatsApp(normalized, onProgress);
  onProgress({ percent: 96, message: 'Building Excel sheet...' });
  const file = await generateExcel(rows, `url-leads-${Date.now()}.xlsx`);
  onProgress({ percent: 100, message: 'Verification complete' });
  return summarize(rows, file, duplicatesRemoved);
}

async function processKeywordScrape(keyword, country, onProgress = () => {}) {
  onProgress({ percent: 4, message: 'Searching public business listings...' });
  const leads = await scrapeByKeywordAndCountry(keyword, country);
  const normalized = leads.map((lead) => ({
    name: lead.name,
    number: lead.number,
    source: lead.sourceUrl || '',
  }));
  const { rows, duplicatesRemoved } = await enrichWithWhatsApp(normalized, onProgress);
  onProgress({ percent: 96, message: 'Building Excel sheet...' });
  const file = await generateExcel(rows, `keyword-leads-${Date.now()}.xlsx`);
  onProgress({ percent: 100, message: 'Verification complete' });
  return summarize(rows, file, duplicatesRemoved);
}

module.exports = {
  processExcelFile,
  processUrlScrape,
  processKeywordScrape,
};
