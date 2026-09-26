const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// Broader internal link discovery: path patterns + link text keywords
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

// Strong international + local phone patterns
const PHONE_PATTERNS = [
  // +CC or 00CC followed by number (international)
  /(?:\+|00)[1-9]\d{0,3}[\s.\-()]*\d(?:[\d\s.\-()]{5,18}\d)/g,
  // (XXX) XXX-XXXX style
  /\(\d{2,5}\)[\s.\-]?\d{2,5}[\s.\-]?\d{2,6}/g,
  // 0XX-XXX-XXXX local with leading 0
  /\b0\d{1,4}[\s.\-]\d{2,5}[\s.\-]\d{2,6}\b/g,
  // Indian mobile 10-digit starting 6-9
  /\b[6-9]\d{9}\b/g,
  // Indian with spaces/dashes 5+5
  /\b[6-9]\d{4}[\s.\-]?\d{5}\b/g,
  // Generic 10-15 digit sequences that look like phones (word boundary)
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
};

// Known valid country calling codes (subset, most common)
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

/**
 * Normalize a raw phone string into digits-only international form.
 * - Preserves country code when present (+ or 00 or known length).
 * - Does NOT force India (+91) or any other country.
 * - Returns null for invalid / junk numbers.
 */
function normalizePhone(raw) {
  const source = String(raw || '').trim();
  if (!source) return null;

  const hadPlusOr00 = /^(?:\+|00)/.test(source.replace(/\s/g, '')) || source.includes('+');

  let digits = source.replace(/\D/g, '');
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  // Leading trunk 0 for local numbers (e.g. 09876... -> 9876...)
  if (!hadPlusOr00 && digits.length >= 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  if (digits.length < 8 || digits.length > 15) return null;
  if (/^(\d)\1{7,}$/.test(digits)) return null; // all same digit

  // If original had international indicator, keep full digits as-is
  if (hadPlusOr00) {
    // Must start with a plausible country code
    if (!startsWithValidCountryCode(digits)) return null;
    return digits;
  }

  // No explicit country code in source.
  // Accept common local shapes:
  // - 10 digits (many countries)
  // - 11 digits starting with country-like prefix already present in digits
  if (digits.length === 10) {
    return digits;
  }

  if (digits.length >= 11 && startsWithValidCountryCode(digits)) {
    return digits;
  }

  // 8-9 digit local (some countries) — keep if looks phone-like
  if (digits.length >= 8 && digits.length <= 9) {
    const hasPhoneShape = /[+\-().\s]/.test(source);
    if (hasPhoneShape) return digits;
  }

  return null;
}

function startsWithValidCountryCode(digits) {
  // Try 1, 2, 3 digit codes
  for (const len of [1, 2, 3]) {
    if (digits.length > len && VALID_COUNTRY_CODES.has(digits.slice(0, len))) {
      return true;
    }
  }
  return false;
}

/**
 * Apply country code ONLY as fallback for clearly local numbers
 * during keyword+country search. Never override an existing country code.
 */
function applyCountryCode(number, country) {
  if (!number) return number;
  const code = CALLING_CODES[cleanText(country).toLowerCase()];
  if (!code) return number;

  // Already has this or another country code
  if (number.startsWith(code)) return number;
  if (startsWithValidCountryCode(number) && number.length > 10) return number;

  // Only prefix local-looking numbers
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
    /[A-Za-z]/.test(containerText) &&
    !/\d{6,}/.test(containerText)
  ) {
    return containerText;
  }

  return fallback;
}

/**
 * Extract phone numbers from HTML using multiple strategies.
 */
function extractLeadsFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg').remove();

  const fallbackName = pageName($).slice(0, 120);
  const leads = [];
  const seen = new Set();

  const addLead = (raw, name) => {
    const number = normalizePhone(raw);
    if (!number || seen.has(number)) return;
    seen.add(number);
    leads.push({
      name: cleanText(name).slice(0, 120) || fallbackName,
      number,
      sourceUrl: pageUrl,
    });
  };

  // 1. tel: links (most reliable)
  $('a[href^="tel:"], a[href^="TEL:"], a[href^="Tel:"]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const raw = decodeURIComponent(href.replace(/^tel:/i, '').split('?')[0].split(';')[0]);
    addLead(raw, contextName($, element, fallbackName));
  });

  // 2. data attributes commonly used for phones
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

  // 3. JSON-LD structured data
  $('script[type="application/ld+json"]').each((_, element) => {
    try {
      const data = JSON.parse($(element).html() || '{}');
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        walkJsonForPhones(item, (phone) => addLead(phone, fallbackName));
      }
    } catch {
      // ignore invalid JSON-LD
    }
  });

  // 4. Meta tags
  $('meta[property="og:phone_number"], meta[name="telephone"], meta[name="phone"], meta[itemprop="telephone"]').each(
    (_, element) => {
      const content = $(element).attr('content');
      if (content) addLead(content, fallbackName);
    }
  );

  // 5. Visible body text with regex patterns
  const text = $('body').text();
  for (const pattern of PHONE_PATTERNS) {
    // Reset lastIndex for global regex
    pattern.lastIndex = 0;
    const matches = text.match(pattern) || [];
    for (const raw of matches) {
      addLead(raw, nearbyName($, raw, fallbackName));
    }
  }

  // 6. Also scan entire HTML source for tel: and phone-like strings that cheerio text may miss
  const htmlSource = String(html || '');
  const telMatches = htmlSource.match(/tel:[\s]*[+0-9()\-.\s]{8,20}/gi) || [];
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

  // Also check footer/nav areas more aggressively for any internal links with short paths
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

function looksLikeScriptShell(html) {
  const $ = cheerio.load(html || '');
  $('script, style, noscript').remove();
  const text = cleanText($('body').text());
  return text.length < 180;
}

async function fetchWithAxios(url) {
  const response = await axios.get(url, {
    timeout: 18000,
    maxRedirects: 5,
    maxContentLength: 3 * 1024 * 1024,
    responseType: 'text',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
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

    // Scroll to trigger lazy-loaded content
    await page.evaluate(async () => {
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
        }, 150);
      });
    }).catch(() => undefined);

    // Small wait for any late content
    await new Promise((r) => setTimeout(r, 800));

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

async function scrapeUrl(targetUrl) {
  const parsed = assertHttpUrl(targetUrl);
  const browserHolder = { browser: null };
  const leads = [];

  try {
    const homepage = await fetchHtml(parsed.href, browserHolder);
    leads.push(...extractLeadsFromHtml(homepage, parsed.href));

    const pages = discoverInternalLinks(homepage, parsed.href).filter(
      (link) => link !== parsed.href
    );

    for (const link of pages) {
      try {
        const html = await fetchHtml(link, browserHolder);
        leads.push(...extractLeadsFromHtml(html, link));
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
  const leads = extractLeadsFromHtml(html, searchUrl).map((lead) => ({
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
            // Only apply country code if the number looks local (no country code yet)
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
  // exported for testing
  normalizePhone,
  applyCountryCode,
};
