const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

const PRIMARY_COLUMNS = [
  ['name', 'Name'],
  ['number', 'Number'],
  ['source', 'Source'],
  ['isWhatsApp', 'WhatsApp'],
  ['whatsappJid', 'WhatsApp JID'],
];

function toHeader(key) {
  return String(key)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function safeFileName(fileName) {
  const base = path.basename(String(fileName || `leads-${Date.now()}.xlsx`));
  const cleaned = base.replace(/[^\w.\-]+/g, '_');
  return cleaned.toLowerCase().endsWith('.xlsx') ? cleaned : `${cleaned}.xlsx`;
}

function displayValue(key, value) {
  if (key === 'isWhatsApp' && typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (value === null || value === undefined) return '';
  return value;
}

async function generateExcel(data, fileName) {
  const rows = Array.isArray(data) ? data : [];
  const knownKeys = new Set(PRIMARY_COLUMNS.map(([key]) => key));
  const extraKeys = [];

  for (const row of rows) {
    for (const key of Object.keys(row || {})) {
      if (!knownKeys.has(key) && !extraKeys.includes(key)) {
        extraKeys.push(key);
      }
    }
  }

  const columns = [
    ...PRIMARY_COLUMNS.map(([key, header]) => ({ key, header })),
    ...extraKeys.map((key) => ({ key, header: toHeader(key) })),
  ];

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Lead Extractor';
  const sheet = workbook.addWorksheet('Leads');

  sheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: Math.max(column.header.length + 4, 16),
  }));

  for (const row of rows) {
    const record = {};
    for (const column of columns) {
      record[column.key] = displayValue(column.key, row?.[column.key]);
    }
    sheet.addRow(record);
  }

  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
  header.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F4E79' },
  };
  header.alignment = { vertical: 'middle', horizontal: 'left' };
  header.height = 22;

  sheet.eachRow((row, rowNumber) => {
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD9E2F3' } },
        left: { style: 'thin', color: { argb: 'FFD9E2F3' } },
        bottom: { style: 'thin', color: { argb: 'FFD9E2F3' } },
        right: { style: 'thin', color: { argb: 'FFD9E2F3' } },
      };

      if (rowNumber > 1 && rowNumber % 2 === 0) {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF3F6FB' },
        };
      }
    });
  });

  sheet.columns.forEach((column) => {
    let width = String(column.header || '').length;
    column.eachCell({ includeEmpty: false }, (cell) => {
      const length = cell.value === null || cell.value === undefined ? 0 : String(cell.value).length;
      if (length > width) width = length;
    });
    column.width = Math.min(Math.max(width + 3, 14), 46);
  });

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(sheet.rowCount, 1), column: columns.length },
  };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const storedName = safeFileName(fileName);
  const filePath = path.join(UPLOADS_DIR, storedName);
  await workbook.xlsx.writeFile(filePath);

  return {
    filePath,
    fileName: storedName,
    downloadUrl: `/api/process/download/${encodeURIComponent(storedName)}`,
  };
}

module.exports = {
  generateExcel,
  UPLOADS_DIR,
};
