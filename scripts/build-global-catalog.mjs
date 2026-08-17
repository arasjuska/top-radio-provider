import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DIST = new URL('../dist/catalog/', import.meta.url);
const EXTRA = new URL('../data/global-extra.json', import.meta.url);
const VERIFIED = new URL('../dist/stations.json', import.meta.url);
const RB_DB_URL = 'https://db.radio-browser.info/all.json';
const IPRD_ROOT = path.resolve(process.cwd(), 'vendor/iprd/streams');
const GENERIC = new Set(['radio','fm','station','stream','live','online','the','la','le','el','das','der','di','de']);

const byKey = new Map();
const verified = await readJson(VERIFIED, { stations: [] });
for (const station of verified.stations || []) addStation({
  id: station.id,
  name: station.name,
  aliases: station.aliases || [],
  countrycode: station.countrycode === 'HQ' ? (station.originCountrycode || '') : station.countrycode,
  homepage: station.homepage || '',
  logoUrl: station.logoUrl || '',
  tags: station.tags || station.genre || '',
  language: station.language || '',
  curated: true,
  streams: [station.best, ...(station.fallbacks || [])].filter(Boolean).map((s) => ({
    url: s.url,
    codec: s.codec || '', bitrate: Number(s.bitrate) || 0, sampling: Number(s.sampling) || 0,
    bitDepth: Number(s.bitDepth) || 0, hls: Number(s.hls) || 0,
    source: 'top-radio-provider', trusted: true, official: s.official === true,
  })),
});

try {
  const rows = await fetchJson(RB_DB_URL, 20000);
  for (const row of rows || []) {
    if (!row?.name || !/^https?:\/\//i.test(row.url || '')) continue;
    addStation({
      id: `rb:${row.stationuuid || shortHash(`${row.countrycode}|${row.name}|${row.url}`)}`,
      name: row.name,
      countrycode: row.countrycode || '',
      homepage: row.homepage || '',
      logoUrl: row.favicon || '',
      tags: row.tags || '',
      language: row.languagecodes || '',
      streams: [{ url: row.url, source: 'radio-browser-global', trusted: false, stationuuid: row.stationuuid || '' }],
    });
  }
} catch (error) {
  console.warn('Global Radio Browser DB unavailable:', error?.message || error);
}

try {
  const countryDirs = await fs.readdir(IPRD_ROOT, { withFileTypes: true });
  for (const dir of countryDirs) {
    if (!dir.isDirectory() || !/^[a-z]{2}$/i.test(dir.name)) continue;
    const folder = path.join(IPRD_ROOT, dir.name);
    const files = (await fs.readdir(folder)).filter((f) => f.endsWith('.m3u'));
    for (const file of files) {
      const text = await fs.readFile(path.join(folder, file), 'utf8');
      for (const item of parseM3u(text)) {
        if (!item.name || !/^https?:\/\//i.test(item.url)) continue;
        addStation({
          id: `iprd:${dir.name}:${slug(item.name)}:${shortHash(item.url).slice(0,6)}`,
          name: item.name,
          countrycode: dir.name.toUpperCase(),
          streams: [{ url: item.url, source: 'iprd-global', trusted: false }],
        });
      }
    }
  }
} catch (error) {
  console.warn('IPRD global import unavailable:', error?.message || error);
}

const extra = await readJson(EXTRA, { stations: [] });
for (const [id, name, absSlug, cdnSlug] of extra.stations || []) {
  addStation({
    id: `extra:${id}`,
    name,
    aliases: [name.replace('Zaycev.FM', 'Зайцев.FM')],
    countrycode: 'RU',
    homepage: `https://www.zaycev.fm/${absSlug === 'rock' ? 'newrock' : absSlug}`,
    logoUrl: 'https://www.zaycev.fm/favicon.ico',
    tags: name.replace('Zaycev.FM ', ''),
    curated: true,
    streams: [
      { url: `https://abs.zaycev.fm/${absSlug}256k`, codec: 'MP3', bitrate: 256, source: 'official-extra', trusted: true, official: true },
      { url: `https://zaycevfm.cdnvideo.ru/ZaycevFM_${cdnSlug}_256.mp3`, codec: 'MP3', bitrate: 256, source: 'curated-extra', trusted: true },
    ],
  });
}

const stations = [...byKey.values()].filter((s) => !isClassical(s));
const shards = new Map();
for (const station of stations) {
  const keys = shardKeysForStation(station);
  const compact = compactStation(station);
  for (const key of keys) {
    if (!shards.has(key)) shards.set(key, []);
    shards.get(key).push(compact);
  }
}

await fs.rm(DIST, { recursive: true, force: true });
await fs.mkdir(DIST, { recursive: true });
for (const [key, list] of shards) {
  list.sort((a,b) => (b.q || 0) - (a.q || 0) || a.name.localeCompare(b.name));
  await fs.writeFile(new URL(`./${key}.json`, DIST), JSON.stringify({ generatedAt: new Date().toISOString(), stations: list }));
}
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  stations: stations.length,
  shards: shards.size,
  minQueryLength: 2,
  sources: ['Top Radio curated', 'Radio Browser DB', 'IPRD', 'global-extra'],
};
await fs.writeFile(new URL('./manifest.json', DIST), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Global catalog built: ${stations.length} stations across ${shards.size} shards.`);

function addStation(input) {
  const name = clean(input.name);
  const cc = String(input.countrycode || '').toUpperCase();
  if (!name) return;
  const key = `${cc}|${normalize(name)}`;
  const existing = byKey.get(key);
  if (!existing) {
    byKey.set(key, { ...input, name, countrycode: cc, aliases: input.aliases || [], streams: dedupeStreams(input.streams || []) });
    return;
  }
  existing.aliases = [...new Set([...(existing.aliases || []), ...(input.aliases || [])])];
  existing.streams = dedupeStreams([...(existing.streams || []), ...(input.streams || [])]);
  existing.homepage ||= input.homepage || '';
  existing.logoUrl ||= input.logoUrl || '';
  existing.tags = [existing.tags, input.tags].filter(Boolean).join(',');
  existing.language ||= input.language || '';
  existing.curated ||= input.curated === true;
  if (input.curated && !String(existing.id).startsWith('extra:')) existing.id = input.id;
}
function compactStation(s) {
  return {
    id: s.id,
    name: s.name,
    aliases: s.aliases || [],
    countrycode: s.countrycode || '',
    homepage: s.homepage || '',
    logoUrl: s.logoUrl || '',
    tags: s.tags || '',
    language: s.language || '',
    globalCatalog: true,
    streams: (s.streams || []).slice(0, 4),
    q: qualityHint(s),
  };
}
function qualityHint(s) {
  return Math.max(0, ...(s.streams || []).map((x) => (x.trusted ? 10000 : 0) + (Number(x.bitrate) || 0)));
}
function shardKeysForStation(s) {
  const text = normalize([s.name, ...(s.aliases || []), s.tags || ''].join(' '));
  const tokens = text.split(/\s+/).filter((t) => t.length >= 2 && !GENERIC.has(t));
  const keys = new Set();
  for (const token of tokens) {
    const chars = [...token];
    for (let i = 0; i < chars.length - 1; i++) keys.add(shardKey(chars[i] + chars[i + 1]));
  }
  return keys.size ? keys : new Set([shardKey([...normalize(s.name)].slice(0,2).join(''))]);
}
function shardKey(pair) { return [...pair].map((c) => c.codePointAt(0).toString(16)).join('-'); }
function normalize(v) { return String(v || '').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim(); }
function clean(v) { return String(v || '').replace(/\s+/g,' ').trim(); }
function slug(v) { return normalize(v).replace(/\s+/g,'-').slice(0,60) || 'station'; }
function shortHash(v) { return crypto.createHash('sha1').update(String(v)).digest('hex').slice(0,12); }
function dedupeStreams(items) { const seen = new Set(); return items.filter((s) => s?.url && !seen.has(s.url) && seen.add(s.url)); }
function isClassical(s) {
  const text = normalize(`${s.name} ${s.tags || ''}`);
  if (/classic rock|classic hits|classic pop|classic dance/.test(text)) return false;
  return /\bclassical\b|\bklassik\b|\bklasika\b|\bclasica\b|\bclassique\b/.test(text);
}
function parseM3u(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = []; let name = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF:')) { name = (line.split(',').slice(1).join(',') || '').trim(); continue; }
    if (/^https?:\/\//i.test(line)) { out.push({ name: name || line, url: line }); name = ''; }
  }
  return out;
}
async function fetchJson(url, timeoutMs) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
  try { const r = await fetch(url, { signal: c.signal, redirect: 'follow' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); }
  finally { clearTimeout(t); c.abort(); }
}
async function readJson(url, fallback) { try { return JSON.parse(await fs.readFile(url, 'utf8')); } catch { return fallback; } }
