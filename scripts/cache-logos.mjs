import fs from 'node:fs/promises';
import path from 'node:path';

const USER_AGENT = 'TopRadioProvider/1.0 (+https://github.com/arasjuska/top-radio-provider)';
const DIST_PATH = new URL('../dist/stations.json', import.meta.url);
const LOGO_DIR = new URL('../dist/logos/', import.meta.url);
const TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;
const CONCURRENCY = 6;
const CDN_BASE = 'https://cdn.jsdelivr.net/gh/arasjuska/top-radio-provider@master/dist/logos';

const payload = JSON.parse(await fs.readFile(DIST_PATH, 'utf8'));
await fs.rm(LOGO_DIR, { recursive: true, force: true });
await fs.mkdir(LOGO_DIR, { recursive: true });

payload.stations = await mapLimit(payload.stations || [], CONCURRENCY, cacheStationLogo);
await fs.writeFile(DIST_PATH, `${JSON.stringify(payload, null, 2)}\n`);

const cached = payload.stations.filter((station) => station.logoSource === 'provider-cache').length;
console.log(`Provider logo cache complete: ${cached}/${payload.stations.length} station logos cached.`);

async function cacheStationLogo(station) {
  const sourceUrl = String(station.logoUrl || '');
  if (!/^https?:\/\//i.test(sourceUrl)) return station;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(sourceUrl, {
      redirect: 'follow',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.4',
      },
    });
    if (!response.ok) return station;

    const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = extensionFor(type, response.url || sourceUrl);
    if (!ext) return station;

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_BYTES) return station;

    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BYTES) return station;

    const filename = `${safeFileName(station.id)}.${ext}`;
    await fs.writeFile(new URL(`./${filename}`, LOGO_DIR), bytes);
    const version = encodeURIComponent(payload.generatedAt || String(Date.now()));

    return {
      ...station,
      logoUrl: `${CDN_BASE}/${filename}?v=${version}`,
      logoSource: 'provider-cache',
      originalLogoUrl: sourceUrl,
    };
  } catch {
    return station;
  } finally {
    clearTimeout(timeout);
    try { await response?.body?.cancel(); } catch {}
  }
}

function extensionFor(contentType, url) {
  const byType = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/svg+xml': 'svg',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'image/avif': 'avif',
  };
  if (byType[contentType]) return byType[contentType];
  const match = String(url || '').match(/\.([a-z0-9]{2,5})(?:$|[?#])/i);
  const ext = String(match?.[1] || '').toLowerCase();
  return ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'avif'].includes(ext)
    ? (ext === 'jpeg' ? 'jpg' : ext)
    : '';
}

function safeFileName(value) {
  return String(value || 'station').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'station';
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
