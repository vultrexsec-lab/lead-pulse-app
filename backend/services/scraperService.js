const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Limits for directory / listing crawls (safety + practical runtime)
const MAX_LISTING_PAGES = Number(process.env.MAX_LISTING_PAGES || 600);
const MAX_PROFILE_PAGES = Number(process.env.MAX_PROFILE_PAGES || 12000);
const PROFILE_CONCURRENCY = Number(process.env.PROFILE_CONCURRENCY || 8);
const REQUEST_DELAY_MS = Number(process.env.SCRAPE_DELAY_MS || 120);

const INTERNAL_LINK_PATTERNS = [
  /\/contact(?:-us|us)?(?:\/|$|\.)/i,
  /\/about(?:-us|us)?(?:\/|$|\.)/i,
  /\/team(?:\/|$|\.)/i,
  /\/staff(?:\/|$|\.)/i,
  /\/people(?:\/|$|\.)/i,
  /\/locations?(?:\/|$|\.)/i,
  /\/offices?(?:\/|$|\.)/i,
  /\/support(?:\/|$|\.)/i,
  /\/get-in-touch(?:\/|$|\.)/i,
  /\/reach-us(?:\/|$|\.)/i,
  /\/connect(?:\/|$|\.)/i,
  /\/enquiry(?:\/|$|\.)/i,
  /\/inquiry(?:\/|$|\.)/i,
  /\/find-us(?:\/|$|\.)/i,
  /\/our-team(?:\/|$|\.)/i,
  /\/directory(?:\/|$|\.)/i,
];

const LINK_TEXT_KEYWORDS = [
  'contact',
  'about',
  'team',
  'call us',
  'phone',
  'reach us',
  'get in touch',
  'support',
  'locations',
  'office',
  'enquiry',
  'inquiry',
  'find us',
  'staff',
  'directory',
];

const PHONE_PATTERNS = [
  /(?:\+|00)[1-9]\d{0,3}[\s.\-()]*\d(?:[\d\s.\-()]{5,18}\d)/g,
  /\(\d{2,5}\)[\s.\-]?\d{2,5}[\s.\-]?\d{2,6}/g,
  /\b0\d{1,4}[\s.\-]\d{2,5}[\s.\-]\d{2,6}\b/g,
  // Greek mobiles 69xxxxxxxx
  /\b69\d{8}\b/g,
  // Greek landlines 2xxxxxxxxx
  /\b2\d{9}\b/g,
  /\b[6-9]\d{9}\b/g,
  /\b[6-9]\d{4}[\s.\-]?\d{5}\b/g,
  /\b\d{3}[\s.\-]\d{3}[\s.\-]\d{4}\b/g,
  /\b\d{2,4}[\s.\-]\d{3,4}[\s.\-]\d{3,4}\b/g,
];

const CALLING_CODES = {
  india: '91',
  in: '91',
  'united states': '1',
  usa: '1',
  us: '1',
  america: '1',
  canada: '1',
  'united kingdom': '44',
  uk: '44',
  britain: '44',
  england: '44',
  uae: '971',
  'united arab emirates': '971',
  dubai: '971',
  australia: '61',
  germany: '49',
  france: '33',
  singapore: '65',
  'saudi arabia': '966',
  qatar: '974',
  kuwait: '965',
  oman: '968',
  bangladesh: '880',
  pakistan: '92',
  nepal: '977',
  'sri lanka': '94',
  greece: '30',
  gr: '30',
  hellas: '30',
};

// TLD / host → default country calling code for local numbers
const HOST_COUNTRY_CODES = [
  [/\.gr$/i, '30'],
  [/\.in$/i, '91'],
  [/\.uk$/i, '44'],
  [/\.co\.uk$/i, '44'],
  [/\.ae$/i, '971'],
  [/\.au$/i, '61'],
  [/\.de$/i, '49'],
  [/\.fr$/i, '33'],
  [/\.sg$/i, '65'],
  [/\.pk$/i, '92'],
  [/\.bd$/i, '880'],
  [/\.np$/i, '977'],
  [/\.lk$/i, '94'],
  [/\.sa$/i, '966'],
  [/\.qa$/i, '974'],
  [/\.kw$/i, '965'],
  [/\.om$/i, '968'],
  [/11888\.gr/i, '30'],
];

const VALID_COUNTRY_CODES = new Set([
  '1', '7', '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45',
  '46', '47', '48', '49', '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63',
  '64', '65', '66', '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98', '212',
  '213', '216', '218', '220', '221', '222', '223', '224', '225', '226', '227', '228', '229',
  '230', '231', '232', '233', '234', '235', '236', '237', '238', '239', '240', '241', '242',
  '243', '244', '245', '246', '248', '249', '250', '251', '252', '253', '254', '255', '256',
  '257', '258', '260', '261', '262', '263', '264', '265', '266', '267', '268', '269', '290',
  '291', '297', '298', '299', '350', '351', '352', '353', '354', '355', '356', '357', '358',
  '359', '370', '371', '372', '373', '374', '375', '376', '377', '378', '380', '381', '382',
  '383', '385', '386', '387', '389', '420', '421', '423', '500', '501', '502', '503', '504',
  '505', '506', '507', '508', '509', '590', '591', '592', '593', '594', '595', '596', '597',
  '598', '599', '670', '672', '673', '674', '675', '676', '677', '678', '679', '680', '681',
  '682', '683', '685', '686', '687', '688', '689', '690', '691', '692', '850', '852', '853',
  '855', '856', '880', '886', '960', '961', '962', '963', '964', '965', '966', '967', '968',
  '970', '971', '972', '973', '974', '975', '976', '977', '992', '993', '994', '995', '996',
  '998',
]);

const SKIP_RESULT_HOSTS = [
  'google.',
  'gstatic.',
  'youtube.',
  'facebook.',
  'instagram.',
  'twitter.',
  'x.com',
  'linkedin.',
  'wikipedia.',
  'webcache.',
];

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw httpError('A valid http(s) URL is required', 400);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw httpError('Only http and https URLs are supported', 400);
  }

  return parsed;
}

function countryCodeFromHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  for (const [re, code] of HOST_COUNTRY_CODES) {
    if (re.test(host)) return code;
  }
  return null;
}

function startsWithValidCountryCode(digits) {
  for (const len of [1, 2, 3]) {
    if (digits.length > len && VALID_COUNTRY_CODES.has(digits.slice(0, len))) {
      return true;
    }
  }
  return false;
}

/**
 * Normalize raw phone → digits only, preserving international codes when present.
 * Optional defaultCountryCode applied only to clearly local numbers.
 */
function normalizePhone(raw, defaultCountryCode = null) {
  const source = String(raw || '').trim();
  if (!source) return null;

  const hadPlusOr00 = /^(?:\+|00)/.test(source.replace(/\s/g, '')) || source.includes('+');

  let digits = source.replace(/\D/g, '');
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (!hadPlusOr00 && digits.length >= 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  if (digits.length < 8 || digits.length > 15) return null;
  if (/^(\d)\1{7,}$/.test(digits)) return null;

  if (hadPlusOr00) {
    if (!startsWithValidCountryCode(digits)) return null;
    return digits;
  }

  // Already international length with valid CC
  if (digits.length >= 11 && startsWithValidCountryCode(digits)) {
    return digits;
  }

  // Local number — apply default country code when known
  if (defaultCountryCode && !digits.startsWith(defaultCountryCode)) {
    // Greece: 10-digit mobiles 69... or landlines 2...
    if (defaultCountryCode === '30' && digits.length === 10 && /^(69|2)\d{8}$/.test(digits)) {
      return `30${digits}`;
    }
    // India: 10-digit starting 6-9
    if (defaultCountryCode === '91' && digits.length === 10 && /^[6-9]/.test(digits)) {
      return `91${digits}`;
    }
    // Generic: 8–10 digit local
    if (digits.length >= 8 && digits.length <= 10) {
      return `${defaultCountryCode}${digits}`;
    }
  }

  if (digits.length === 10) return digits;

  if (digits.length >= 8 && digits.length <= 9) {
    const hasPhoneShape = /[+\-().\s]/.test(source);
    if (hasPhoneShape) return digits;
  }

  return null;
}

function applyCountryCode(number, country) {
  if (!number) return number;
  const code = CALLING_CODES[cleanText(country).toLowerCase()];
  if (!code) return number;
  if (number.startsWith(code)) return number;
  if (startsWithValidCountryCode(number) && number.length > 10) return number;
  if (number.length === 10 || number.length === 9 || number.length === 8) {
    return `${code}${number}`;
  }
  return number;
}

function pageName($) {
  const siteName = cleanText($('meta[property="og:site_name"]').attr('content'));
  const title = cleanText($('title').first().text());
  const heading = cleanText($('h1').first().text());
  return siteName || title || heading || 'Unknown';
}

function nearbyName($, raw, fallback) {
  const needle = cleanText(raw);
  let chosen = fallback;

  $('*').each((_, element) => {
    if (chosen !== fallback) return;

    const own = cleanText($(element).clone().children().remove().end().text());
    if (!own || !own.includes(needle) || own.length > 180) return;

    const heading = cleanText(
      $(element).prevAll('h1, h2, h3, h4').first().text() ||
        $(element).prevAll().find('h1, h2, h3, h4').first().text() ||
        $(element).parent().prevAll('h1, h2, h3, h4').first().text()
    );

    if (heading && heading.length <= 80 && !/\d{6,}/.test(heading)) {
      chosen = heading;
      return;
    }

    const label = contextName($, element, fallback);
    if (label && label !== fallback && !/\d{6,}/.test(label)) {
      chosen = label;
    }
  });

  return chosen;
}

function contextName($, element, fallback) {
  const container = $(element).closest('li, p, tr, article, section, div');
  const heading = cleanText(container.find('h1, h2, h3, h4, strong').first().text());
  if (heading && heading.length <= 80 && !/\d{6,}/.test(heading)) {
    return heading;
  }

  const containerText = cleanText(
    container
      .clone()
      .children('a, span')
      .remove()
      .end()
      .text()
      .replace(/(?:\+|00|\()?[\s.\-]*\d[\d\s().\-]{6,}\d\)?/g, ' ')
      .replace(/^[\s,;:()\-.]+|[\s,;:()\-.]+$/g, '')
  );
  if (
    containerText &&
    containerText.length <= 80 &&
    /[A-Za-zΑ-Ωα-ω]/.test(containerText) &&
    !/\d{6,}/.test(containerText)
  ) {
    return containerText;
  }

  return fallback;
}

function extractLeadsFromHtml(html, pageUrl, defaultCountryCode = null) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg').remove();

  const fallbackName = pageName($).slice(0, 120);
  const leads = [];
  const seen = new Set();

  const addLead = (raw, name) => {
    const number = normalizePhone(raw, defaultCountryCode);
    if (!number || seen.has(number)) return;
    seen.add(number);
    leads.push({
      name: cleanText(name).slice(0, 120) || fallbackName,
      number,
      sourceUrl: pageUrl,
    });
  };

  $('a[href^="tel:"], a[href^="TEL:"], a[href^="Tel:"]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const raw = decodeURIComponent(href.replace(/^tel:/i, '').split('?')[0].split(';')[0]);
    addLead(raw, contextName($, element, fallbackName));
  });

  $('[data-phone], [data-tel], [data-telephone], [data-mobile], [data-contact], [itemprop="telephone"]').each(
    (_, element) => {
      const attrs = ['data-phone', 'data-tel', 'data-telephone', 'data-mobile', 'data-contact', 'content'];
      for (const attr of attrs) {
        const val = $(element).attr(attr);
        if (val) addLead(val, contextName($, element, fallbackName));
      }
      const text = cleanText($(element).text());
      if (text) addLead(text, contextName($, element, fallbackName));
    }
  );

  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const data = JSON.parse($(element).html() || '{}');
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        walkJsonForPhones(item, (phone) => addLead(phone, fallbackName));
      }
    } catch {
      // ignore
    }
  });

  $('meta[property="og:phone_number"], meta[name="telephone"], meta[name="phone"], meta[itemprop="telephone"]').each(
    (_, element) => {
      const content = $(element).attr('content');
      if (content) addLead(content, fallbackName);
    }
  );

  const text = $('body').text();
  for (const pattern of PHONE_PATTERNS) {
    pattern.lastIndex = 0;
    const matches = text.match(pattern) || [];
    for (const raw of matches) {
      addLead(raw, nearbyName($, raw, fallbackName));
    }
  }

  const htmlSource = String(html || '');
  const telMatches = htmlSource.match(/tel:[\s]*[+0-9()\-.\s]{8,22}/gi) || [];
  for (const m of telMatches) {
    addLead(m.replace(/^tel:\s*/i, ''), fallbackName);
  }

  return leads;
}

function walkJsonForPhones(obj, cb, depth = 0) {
  if (!obj || depth > 8) return;
  if (typeof obj === 'string') {
    if (/(?:\+|00)?[\d\s.\-()]{8,}/.test(obj)) cb(obj);
    return;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) walkJsonForPhones(item, cb, depth + 1);
    return;
  }
  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      const k = key.toLowerCase();
      if (
        k.includes('phone') ||
        k.includes('telephone') ||
        k.includes('mobile') ||
        k.includes('tel') ||
        k === 'contactpoint'
      ) {
        if (typeof value === 'string') cb(value);
        else walkJsonForPhones(value, cb, depth + 1);
      } else {
        walkJsonForPhones(value, cb, depth + 1);
      }
    }
  }
}

function discoverInternalLinks(html, pageUrl) {
  const $ = cheerio.load(html);
  const origin = new URL(pageUrl);
  const links = new Set();

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
      return;
    }

    let resolved;
    try {
      resolved = new URL(href, origin);
    } catch {
      return;
    }

    if (resolved.origin !== origin.origin) return;
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return;

    resolved.hash = '';
    const path = resolved.pathname || '/';
    const linkText = cleanText($(element).text()).toLowerCase();

    const pathMatch = INTERNAL_LINK_PATTERNS.some((pattern) => pattern.test(path));
    const textMatch = LINK_TEXT_KEYWORDS.some((kw) => linkText.includes(kw));

    if (pathMatch || textMatch) {
      links.add(resolved.href);
    }
  });

  $('footer a[href], nav a[href], header a[href], [role="navigation"] a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

    let resolved;
    try {
      resolved = new URL(href, origin);
    } catch {
      return;
    }
    if (resolved.origin !== origin.origin) return;
    resolved.hash = '';
    const path = (resolved.pathname || '/').toLowerCase();
    if (
      path.includes('contact') ||
      path.includes('about') ||
      path.includes('team') ||
      path.includes('support') ||
      path.includes('location') ||
      path.includes('office')
    ) {
      links.add(resolved.href);
    }
  });

  return [...links].slice(0, 12);
}

/**
 * Detect directory / white-pages style listing pages.
 */
function isListingPage(html, pageUrl) {
  const url = String(pageUrl || '').toLowerCase();
  if (/11888\.gr\/white-pages/i.test(url)) return true;
  if (/white-?pages|yellow-?pages|directory|katalog|phonebook|people\/search/i.test(url)) {
    return true;
  }

  const $ = cheerio.load(html || '');
  const profileLinks = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (/\/white-pages\/\d+/i.test(href)) profileLinks.add(href);
    if (/\/(profile|person|listing|detail)\/[\w-]+/i.test(href)) profileLinks.add(href);
  });

  // Pagination signals
  const hasPageParam =
    /[?&]page=\d+/i.test(html) ||
    /hx-get=["'][^"']*[?&]page=\d+/i.test(html) ||
    $('button.paginator-btn, .pagination a, .paginator a, nav[aria-label*="page" i]').length > 0;

  return profileLinks.size >= 5 || (profileLinks.size >= 3 && hasPageParam);
}

/**
 * Collect profile detail URLs from a listing HTML.
 */
function extractProfileLinks(html, pageUrl) {
  const $ = cheerio.load(html || '');
  const origin = new URL(pageUrl);
  const links = new Set();

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    let resolved;
    try {
      resolved = new URL(href, origin);
    } catch {
      return;
    }
    if (resolved.origin !== origin.origin) return;
    resolved.hash = '';
    const path = resolved.pathname || '';
    // 11888.gr profiles
    if (/\/white-pages\/\d+\/?$/i.test(path)) {
      links.add(resolved.href.replace(/\/?$/, '/'));
      return;
    }
    // generic profile-like paths with numeric or slug id
    if (/\/(profile|person|people|listing|detail|entry)\/[\w-]+\/?$/i.test(path)) {
      links.add(resolved.href);
    }
  });

  // Also scan raw HTML for 11888 style ids embedded in JSON
  const re = /\/white-pages\/(\d+)\/?/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    links.add(`${origin.origin}/white-pages/${m[1]}/`);
  }

  return [...links];
}

/**
 * Discover max page number and build page URLs for listing.
 */
function buildListingPageUrls(html, pageUrl) {
  const parsed = new URL(pageUrl);
  const pages = new Set([parsed.href]);

  // Ensure page=1 base
  const base = new URL(pageUrl);
  if (!base.searchParams.has('page')) {
    base.searchParams.set('page', '1');
  }
  pages.add(base.href);

  let maxPage = 1;

  // hx-get="/white-pages/?query=maria&page=11953"
  const hxPages = String(html || '').matchAll(/[?&]page=(\d+)/gi);
  for (const match of hxPages) {
    const n = parseInt(match[1], 10);
    if (Number.isFinite(n) && n > maxPage) maxPage = n;
  }

  // pagination buttons text
  const $ = cheerio.load(html || '');
  $('button.paginator-btn, .pagination a, .paginator a, a[href*="page="]').each((_, el) => {
    const text = cleanText($(el).text());
    const n = parseInt(text, 10);
    if (Number.isFinite(n) && n > maxPage) maxPage = n;
    const href = $(el).attr('href') || $(el).attr('hx-get') || '';
    const pm = href.match(/[?&]page=(\d+)/i);
    if (pm) {
      const pn = parseInt(pm[1], 10);
      if (Number.isFinite(pn) && pn > maxPage) maxPage = pn;
    }
  });

  // Cap pages
  maxPage = Math.min(maxPage, MAX_LISTING_PAGES);

  for (let p = 1; p <= maxPage; p += 1) {
    const u = new URL(pageUrl);
    u.searchParams.set('page', String(p));
    pages.add(u.href);
  }

  return { pageUrls: [...pages], maxPage };
}

function looksLikeScriptShell(html) {
  const $ = cheerio.load(html || '');
  $('script, style, noscript').remove();
  const text = cleanText($('body').text());
  return text.length < 180;
}

async function fetchWithAxios(url) {
  const response = await axios.get(url, {
    timeout: 20000,
    maxRedirects: 5,
    maxContentLength: 4 * 1024 * 1024,
    responseType: 'text',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en,el;q=0.9',
    },
    validateStatus: (status) => status >= 200 && status < 400,
  });

  return response.data;
}

async function getBrowser(browserHolder) {
  if (browserHolder.browser) return browserHolder.browser;

  browserHolder.browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  return browserHolder.browser;
}

async function fetchWithPuppeteer(url, browserHolder) {
  const browser = await getBrowser(browserHolder);
  const page = await browser.newPage();

  try {
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1366, height: 768 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 35000 }).catch(() =>
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    );

    await page
      .evaluate(async () => {
        await new Promise((resolve) => {
          let total = 0;
          const distance = 400;
          const timer = setInterval(() => {
            window.scrollBy(0, distance);
            total += distance;
            if (total >= document.body.scrollHeight || total > 4000) {
              clearInterval(timer);
              resolve();
            }
          }, 120);
        });
      })
      .catch(() => undefined);

    await sleep(600);
    return await page.content();
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function fetchHtml(url, browserHolder) {
  try {
    const html = await fetchWithAxios(url);
    if (!looksLikeScriptShell(html)) return html;
  } catch (error) {
    if (!browserHolder) throw error;
  }

  try {
    return await fetchWithPuppeteer(url, browserHolder);
  } catch (error) {
    throw httpError(
      `Could not fetch ${url}. ${error.message || 'The page did not return readable HTML.'}`,
      502
    );
  }
}

async function closeBrowser(browserHolder) {
  if (!browserHolder?.browser) return;
  await browserHolder.browser.close().catch(() => undefined);
  browserHolder.browser = null;
}

function dedupeLeads(leads) {
  const byNumber = new Map();

  for (const lead of leads) {
    const existing = byNumber.get(lead.number);
    if (!existing) {
      byNumber.set(lead.number, lead);
      continue;
    }

    const existingIsSearch = /google\./i.test(existing.sourceUrl || '');
    const nextIsSearch = /google\./i.test(lead.sourceUrl || '');
    if (existingIsSearch && !nextIsSearch) {
      byNumber.set(lead.number, lead);
    }
  }

  return [...byNumber.values()];
}

/**
 * Map-pool concurrency helper
 */
async function mapPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function run() {
    while (index < items.length) {
      const i = index;
      index += 1;
      results[i] = await worker(items[i], i);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => run());
  await Promise.all(runners);
  return results;
}

/**
 * Scrape a directory / white-pages listing: paginate → profiles → phones.
 */
async function scrapeListingDirectory(startUrl, browserHolder, defaultCountryCode) {
  const firstHtml = await fetchHtml(startUrl, browserHolder);
  const { pageUrls, maxPage } = buildListingPageUrls(firstHtml, startUrl);

  console.log(`[scraper] Listing detected. Pages to crawl: ${pageUrls.length} (maxPage=${maxPage})`);

  const profileSet = new Set();
  const leads = [];

  // Always process first page HTML we already have
  for (const link of extractProfileLinks(firstHtml, startUrl)) {
    profileSet.add(link);
  }
  leads.push(...extractLeadsFromHtml(firstHtml, startUrl, defaultCountryCode));

  // Remaining listing pages
  const otherPages = pageUrls.filter((u) => {
    try {
      const a = new URL(u);
      const b = new URL(startUrl);
      return a.searchParams.get('page') !== (b.searchParams.get('page') || '1') || a.href !== b.href;
    } catch {
      return true;
    }
  });

  // Skip page=1 duplicate of start
  const pagesToFetch = otherPages.filter((u) => {
    const p = new URL(u).searchParams.get('page');
    return p && p !== '1';
  });

  let pagesDone = 0;
  for (const pageUrl of pagesToFetch) {
    if (profileSet.size >= MAX_PROFILE_PAGES) break;
    try {
      const html = await fetchHtml(pageUrl, browserHolder);
      for (const link of extractProfileLinks(html, pageUrl)) {
        profileSet.add(link);
      }
      leads.push(...extractLeadsFromHtml(html, pageUrl, defaultCountryCode));
      pagesDone += 1;
      if (pagesDone % 25 === 0) {
        console.log(`[scraper] Listing pages: ${pagesDone}/${pagesToFetch.length}, profiles: ${profileSet.size}`);
      }
      if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
    } catch (err) {
      console.warn(`[scraper] Listing page failed ${pageUrl}: ${err.message}`);
    }
  }

  const profiles = [...profileSet].slice(0, MAX_PROFILE_PAGES);
  console.log(`[scraper] Fetching ${profiles.length} profile pages for phone numbers...`);

  const profileLeads = await mapPool(profiles, PROFILE_CONCURRENCY, async (profileUrl, i) => {
    try {
      if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS * (i % PROFILE_CONCURRENCY));
      const html = await fetchWithAxios(profileUrl).catch(() => null);
      if (!html) return [];
      return extractLeadsFromHtml(html, profileUrl, defaultCountryCode);
    } catch (err) {
      console.warn(`[scraper] Profile failed ${profileUrl}: ${err.message}`);
      return [];
    }
  });

  for (const batch of profileLeads) {
    if (Array.isArray(batch)) leads.push(...batch);
  }

  console.log(`[scraper] Listing scrape done. Raw leads: ${leads.length}`);
  return dedupeLeads(leads);
}

async function scrapeUrl(targetUrl) {
  const parsed = assertHttpUrl(targetUrl);
  const browserHolder = { browser: null };
  const defaultCountryCode = countryCodeFromHost(parsed.hostname);
  const leads = [];

  try {
    const homepage = await fetchHtml(parsed.href, browserHolder);

    if (isListingPage(homepage, parsed.href)) {
      return await scrapeListingDirectory(parsed.href, browserHolder, defaultCountryCode);
    }

    leads.push(...extractLeadsFromHtml(homepage, parsed.href, defaultCountryCode));

    const pages = discoverInternalLinks(homepage, parsed.href).filter(
      (link) => link !== parsed.href
    );

    for (const link of pages) {
      try {
        const html = await fetchHtml(link, browserHolder);
        leads.push(...extractLeadsFromHtml(html, link, defaultCountryCode));
      } catch (error) {
        console.warn(`Skipped ${link}: ${error.message}`);
      }
    }
  } finally {
    await closeBrowser(browserHolder);
  }

  return dedupeLeads(leads);
}

function unwrapGoogleHref(href) {
  if (!href) return null;

  try {
    if (href.startsWith('/url?') || href.includes('google.com/url?')) {
      const parsed = new URL(href, 'https://www.google.com');
      const target = parsed.searchParams.get('q') || parsed.searchParams.get('url');
      return target || null;
    }

    if (href.startsWith('http://') || href.startsWith('https://')) {
      return href;
    }
  } catch {
    return null;
  }

  return null;
}

function isBusinessResultUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return !SKIP_RESULT_HOSTS.some((host) => parsed.hostname.includes(host));
  } catch {
    return false;
  }
}

function parseSearchResults(html, searchUrl, country) {
  const $ = cheerio.load(html);
  const defaultCode = CALLING_CODES[cleanText(country).toLowerCase()] || null;
  const leads = extractLeadsFromHtml(html, searchUrl, defaultCode).map((lead) => ({
    ...lead,
    number: applyCountryCode(lead.number, country),
  }));
  const websites = [];
  const seenSites = new Set();

  $('a[href]').each((_, element) => {
    const url = unwrapGoogleHref($(element).attr('href'));
    if (!url || !isBusinessResultUrl(url) || seenSites.has(url)) return;

    const name = cleanText($(element).find('h3').text() || $(element).text());
    if (!name || name.length < 2) return;

    seenSites.add(url);
    websites.push({ name: name.slice(0, 120), url });
  });

  return { leads, websites: websites.slice(0, 5) };
}

async function scrapeByKeywordAndCountry(keyword, country) {
  const cleanKeyword = cleanText(keyword);
  const cleanCountry = cleanText(country);

  if (!cleanKeyword || !cleanCountry) {
    throw httpError('keyword and country are required', 400);
  }

  const query = `${cleanKeyword} ${cleanCountry}`;
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en&num=10`;
  const browserHolder = { browser: null };

  try {
    const html = await fetchHtml(searchUrl, browserHolder);
    const { leads, websites } = parseSearchResults(html, searchUrl, cleanCountry);

    if (leads.length === 0 && websites.length === 0) {
      throw httpError(
        'No public search results could be read. The search page did not return business listings.',
        502
      );
    }

    for (const site of websites) {
      try {
        const siteLeads = await scrapeUrl(site.url);
        for (const lead of siteLeads) {
          leads.push({
            name: lead.name === 'Unknown' ? site.name : lead.name,
            number: applyCountryCode(lead.number, cleanCountry),
            sourceUrl: lead.sourceUrl || site.url,
          });
        }
      } catch (error) {
        console.warn(`Skipped result ${site.url}: ${error.message}`);
      }
    }

    return dedupeLeads(leads);
  } finally {
    await closeBrowser(browserHolder);
  }
}

module.exports = {
  scrapeUrl,
  scrapeByKeywordAndCountry,
  normalizePhone,
  applyCountryCode,
};
