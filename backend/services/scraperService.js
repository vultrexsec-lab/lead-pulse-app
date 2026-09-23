const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const INTERNAL_LINK_PATTERNS = [
  /\/contact-us(?:\/|$|\.)/i,
  /\/contactus(?:\/|$|\.)/i,
  /\/about-us(?:\/|$|\.)/i,
  /\/aboutus(?:\/|$|\.)/i,
  /\/contact(?:\/|$|\.)/i,
  /\/about(?:\/|$|\.)/i,
  /\/team(?:\/|$|\.)/i,
];

const PHONE_PATTERNS = [
  /(?:\+|00)\d{1,3}[\s.\-]*\d(?:[\d\s.\-()]{6,18}\d)/g,
  /\(\d{2,5}\)[\s.\-]?\d{3,5}[\s.\-]?\d{3,5}/g,
  /\b0\d{2,4}[\s.\-]\d{3,4}[\s.\-]\d{3,4}\b/g,
  /\b0[6-9]\d{9}\b/g,
  /\b[6-9]\d{4}[\s.\-]?\d{5}\b/g,
  /\b[6-9]\d{9}\b/g,
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

function normalizePhone(raw) {
  const source = String(raw || '').trim();
  if (!source) return null;

  let digits = source.replace(/\D/g, '');
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  if (
    digits.length === 12 &&
    digits.startsWith('91') &&
    /^[6-9]/.test(digits.slice(2))
  ) {
    digits = digits.slice(2);
  }

  if (digits.length < 10 || digits.length > 15) return null;
  if (/^(\d)\1+$/.test(digits)) return null;
  const hasPhoneShape = /[+\-().]/.test(source) || /\s/.test(source);
  if (digits.length === 10 && !/^[6-9]/.test(digits) && !hasPhoneShape) {
    return null;
  }

  return digits;
}

function applyCountryCode(number, country) {
  const code = CALLING_CODES[cleanText(country).toLowerCase()];
  if (!code || number.startsWith(code)) return number;
  if (number.length === 10) return `${code}${number}`;
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

  $('a[href^="tel:"]').each((_, element) => {
    const href = $(element).attr('href') || '';
    const raw = decodeURIComponent(href.replace(/^tel:/i, '').split('?')[0]);
    addLead(raw, contextName($, element, fallbackName));
  });

  const text = $('body').text();
  for (const pattern of PHONE_PATTERNS) {
    const matches = text.match(pattern) || [];
    for (const raw of matches) {
      addLead(raw, nearbyName($, raw, fallbackName));
    }
  }

  return leads;
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
    if (!INTERNAL_LINK_PATTERNS.some((pattern) => pattern.test(resolved.pathname))) return;

    resolved.hash = '';
    links.add(resolved.href);
  });

  return [...links].slice(0, 8);
}

function looksLikeScriptShell(html) {
  const $ = cheerio.load(html || '');
  $('script, style, noscript').remove();
  const text = cleanText($('body').text());
  return text.length < 180;
}

async function fetchWithAxios(url) {
  const response = await axios.get(url, {
    timeout: 15000,
    maxRedirects: 5,
    maxContentLength: 2 * 1024 * 1024,
    responseType: 'text',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
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
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  return browserHolder.browser;
}

async function fetchWithPuppeteer(url, browserHolder) {
  const browser = await getBrowser(browserHolder);
  const page = await browser.newPage();

  try {
    await page.setUserAgent(USER_AGENT);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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

    const existingIsSearch = /google\./i.test(existing.sourceUrl);
    const nextIsSearch = /google\./i.test(lead.sourceUrl);
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
};
