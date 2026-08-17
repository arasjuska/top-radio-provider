import fs from 'node:fs/promises';
import { exactStationNameMatch } from './lib.mjs';

const USER_AGENT = 'TopRadioProvider/1.0 (+https://github.com/arasjuska/top-radio-provider)';
const DIST_PATH = new URL('../dist/stations.json', import.meta.url);
const SOURCE_FILES = ['lt', 'it', 'ru', 'hq'].map((code) => new URL(`../data/stations.${code}.json`, import.meta.url));
const API_SERVERS = [
  'https://de2.api.radio-browser.info',
  'https://fi1.api.radio-browser.info',
  'https://de1.api.radio-browser.info',
];
const TIMEOUT_MS = 4000;
const HTML_LIMIT = 320 * 1024;
const CONCURRENCY = 8;

const payload = JSON.parse(await fs.readFile(DIST_PATH, 'utf8'));
const sourceMap = new Map();
for (const sourceFile of SOURCE_FILES) {
  const source = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
  for (const station of source.stations || []) sourceMap.set(station.id, station);
}

payload.stations = await mapLimit(payload.stations || [], CONCURRENCY, enrichStation);
await fs.writeFile(DIST_PATH, `${JSON.stringify(payload, null, 2)}\n`);
const withLogo = payload.stations.filter((station) => station.logoUrl).length;
console.log(`Logo enrichment complete: ${withLogo}/${payload.stations.length} stations have a validated logo.`);

async function enrichStation(station) {
  const source = sourceMap.get(station.id) || station;
  let directory = {};
  try { directory = await radioBrowserMeta(source); } catch {}

  let logoUrl = '';
  let logoSource = '';
  const direct = [
    [source.logoUrl || source.favicon || '', 'curated'],
    [directory.favicon || '', 'radio-browser'],
  ];

  for (const [url, sourceName] of direct) {
    const validated = await validateImageUrl(url);
    if (validated) { logoUrl = validated; logoSource = sourceName; break; }
  }

  const homepage = source.homepage || station.homepage || directory.homepage || '';
  if (!logoUrl && /^https?:\/\//i.test(homepage)) {
    try {
      const candidates = await discoverHomepageLogos(homepage);
      for (const candidate of candidates) {
        const validated = await validateImageUrl(candidate.url);
        if (validated) { logoUrl = validated; logoSource = candidate.source; break; }
      }
    } catch {}
  }

  if (!logoUrl && /^https?:\/\//i.test(homepage)) {
    try {
      const root = new URL('/favicon.ico', homepage).toString();
      const validated = await validateImageUrl(root);
      if (validated) { logoUrl = validated; logoSource = 'homepage-favicon'; }
    } catch {}
  }

  return {
    ...station,
    genre: station.genre || source.genre || directory.tags || '',
    tags: directory.tags || source.tags || station.tags || '',
    language: directory.language || source.language || station.language || '',
    homepage: homepage || '',
    logoUrl,
    logoSource,
  };
}

async function radioBrowserMeta(station) {
  const cc = station.countrycode === 'HQ' ? station.originCountrycode : station.countrycode;
  if (!cc) return {};
  const names = [station.name, ...(station.aliases || [])].filter(Boolean).slice(0, 3);
  for (const name of names) {
    const params = new URLSearchParams({ countrycode: cc, name, nameExact: 'true', hidebroken: 'true', limit: '12' });
    const rows = await rbJson(`/json/stations/search?${params}`);
    const row = (rows || []).find((candidate) => exactStationNameMatch(station, candidate.name || ''));
    if (!row) continue;
    return {
      favicon: /^https?:\/\//i.test(row.favicon || '') ? row.favicon : '',
      homepage: /^https?:\/\//i.test(row.homepage || '') ? row.homepage : '',
      tags: row.tags || '',
      language: row.language || '',
    };
  }
  return {};
}

async function rbJson(path) {
  let lastError;
  for (const base of API_SERVERS) {
    try { return JSON.parse(await fetchText(`${base}${path}`, TIMEOUT_MS)); }
    catch (error) { lastError = error; }
  }
  throw lastError || new Error('Radio Browser unavailable');
}

async function discoverHomepageLogos(homepage) {
  const response = await fetchWithTimeout(homepage, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
  });
  if (!response.ok) return [];
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('html')) return [];
  const html = (await response.text()).slice(0, HTML_LIMIT);
  const base = response.url || homepage;
  const candidates = [];

  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const attrs = parseAttrs(tag);
    const rel = (attrs.rel || '').toLowerCase();
    if (!attrs.href) continue;
    if (rel.includes('apple-touch-icon')) pushLogo(candidates, attrs.href, base, 500, 'apple-touch-icon');
    else if (rel.includes('icon')) pushLogo(candidates, attrs.href, base, 400, 'homepage-icon');
  }

  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const attrs = parseAttrs(tag);
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'].includes(key)) {
      pushLogo(candidates, attrs.content, base, key.startsWith('og:') ? 300 : 250, key);
    }
  }

  return candidates
    .sort((a, b) => b.priority - a.priority)
    .filter((item, index, array) => array.findIndex((candidate) => candidate.url === item.url) === index);
}

function pushLogo(list, value, base, priority, source) {
  const url = resolveHttpUrl(value, base);
  if (url) list.push({ url, priority, source });
}

function parseAttrs(tag) {
  const attrs = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = pattern.exec(tag || ''))) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function resolveHttpUrl(value, base) {
  if (!value) return '';
  try {
    const url = new URL(value, base).toString();
    return /^https?:\/\//i.test(url) ? url : '';
  } catch { return ''; }
}

async function validateImageUrl(value) {
  if (!/^https?:\/\//i.test(value || '')) return '';
  let response;
  try {
    response = await fetchWithTimeout(value, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.4',
        Range: 'bytes=0-4095',
      },
    });
    if (!response.ok && response.status !== 206) return '';
    const type = (response.headers.get('content-type') || '').toLowerCase();
    const finalUrl = response.url || value;
    const imageExtension = /\.(?:png|jpe?g|webp|gif|svg|ico|avif)(?:$|[?#])/i.test(finalUrl);
    if (!type.startsWith('image/') && !imageExtension) return '';
    return finalUrl;
  } catch { return ''; }
  finally { try { await response?.body?.cancel(); } catch {} }
}

async function fetchText(url, timeoutMs) {
  const response = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } }, timeoutMs);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, redirect: 'follow', cache: 'no-store', signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}
