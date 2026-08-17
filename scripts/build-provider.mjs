import fs from 'node:fs/promises';
import dns from 'node:dns/promises';
import {
  parseM3u,
  parsePlaylistByType,
  looksLikeHls,
  parseHlsBestAudio,
  codecFromContentType,
  parseIceAudioInfo,
  inspectAudioBytes,
  streamScore,
  dedupeStreams,
  exactStationNameMatch,
} from './lib.mjs';

const USER_AGENT = 'TopRadioProvider/1.0 (+https://github.com/arasjuska/top-radio-provider)';
const SOURCE_FILES = ['lt', 'it', 'ru', 'hq'].map((code) => new URL(`../data/stations.${code}.json`, import.meta.url));
const DIST_PATH = new URL('../dist/stations.json', import.meta.url);
const STATUS_PATH = new URL('../dist/status.json', import.meta.url);
const FETCH_TIMEOUT = 5500;
const PROBE_BYTES = 96 * 1024;
const STATION_CONCURRENCY = 10;
const MAX_CANDIDATES_PER_STATION = 6;
const RB_LIMIT = 12;

const stations = [];
for (const sourceFile of SOURCE_FILES) {
  const source = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
  stations.push(...(source.stations || []));
}

assertUniqueStationIds(stations);
const rbServers = await discoverRadioBrowserServers();
const iprdCache = new Map();
const results = await mapLimit(stations, STATION_CONCURRENCY, buildStation);
const generatedAt = new Date().toISOString();
const playable = results.filter((station) => station.best).length;
const verifiedStreams = results.reduce((total, station) => total + (station.best ? 1 : 0) + (station.fallbacks?.length || 0), 0);

const payload = {
  schemaVersion: 1,
  generatedAt,
  provider: 'Top Radio Provider',
  policy: {
    qualityFirst: true,
    failClosed: true,
    maxStreamsPerStation: 4,
    sources: ['official/curated', 'IPRD', 'Radio Browser'],
  },
  stats: {
    stations: results.length,
    playable,
    offline: results.length - playable,
    verifiedStreams,
  },
  stations: results,
};

const status = {
  schemaVersion: 1,
  generatedAt,
  ok: playable >= Math.floor(results.length * 0.65),
  stats: payload.stats,
  radioBrowserServers: rbServers,
};

await fs.mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await fs.writeFile(DIST_PATH, `${JSON.stringify(payload, null, 2)}\n`);
await fs.writeFile(STATUS_PATH, `${JSON.stringify(status, null, 2)}\n`);
console.log(`Built ${results.length} stations; playable=${playable}; verifiedStreams=${verifiedStreams}`);

// Do not publish a catastrophically degraded provider snapshot. The previous
// committed dist remains available to the extension if a refresh run fails.
if (playable < Math.floor(results.length * 0.50)) {
  console.error('Too few stations verified; refusing to publish this snapshot.');
  process.exitCode = 2;
}

async function buildStation(station) {
  const candidates = [];

  for (const stream of station.streams || []) {
    candidates.push({
      ...stream,
      source: stream.source || (stream.official ? 'official' : 'curated'),
      identityConfidence: 100,
    });
  }

  try {
    candidates.push(...await candidatesFromIprd(station));
  } catch (error) {
    console.warn('IPRD', station.id, error?.message || error);
  }

  try {
    candidates.push(...await candidatesFromRadioBrowser(station));
  } catch (error) {
    console.warn('RB', station.id, error?.message || error);
  }

  const ranked = dedupeStreams(candidates)
    .sort((a, b) => streamScore(b) - streamScore(a))
    .slice(0, MAX_CANDIDATES_PER_STATION);

  const checked = [];
  for (const candidate of ranked) {
    try {
      const verified = await probeCandidate(station, candidate);
      if (verified) checked.push(verified);
    } catch (error) {
      console.warn('probe', station.id, candidate.url, error?.message || error);
    }
  }

  checked.sort((a, b) => b.score - a.score);
  const selected = checked.slice(0, 4);

  return {
    id: station.id,
    countrycode: station.countrycode,
    originCountrycode: station.originCountrycode || '',
    name: station.name,
    aliases: station.aliases || [],
    genre: station.genre || '',
    homepage: station.homepage || '',
    qualityTier: station.qualityTier || '',
    health: selected.length ? 'ok' : 'offline',
    best: selected[0] || null,
    fallbacks: selected.slice(1),
    candidatesChecked: ranked.length,
    verifiedAt: new Date().toISOString(),
  };
}

async function candidatesFromIprd(station) {
  const cc = (station.countrycode === 'HQ' ? station.originCountrycode : station.countrycode || '').toLowerCase();
  if (!cc || cc === 'hq') return [];

  let entries = iprdCache.get(cc);
  if (!entries) {
    const url = `https://raw.githubusercontent.com/iprd-org/iprd/main/streams/${cc}/${cc}.m3u`;
    const text = await fetchText(url, 5000);
    entries = parseM3u(text, url);
    iprdCache.set(cc, entries);
  }

  return entries
    .filter((entry) => exactStationNameMatch(station, entry.name))
    .slice(0, 6)
    .map((entry) => ({
      url: entry.url,
      source: 'iprd',
      identityConfidence: 94,
    }));
}

async function candidatesFromRadioBrowser(station) {
  const cc = station.countrycode === 'HQ' ? station.originCountrycode : station.countrycode;
  if (!cc || !rbServers.length) return [];

  const names = [station.name, ...(station.aliases || [])].filter(Boolean);
  const found = [];

  for (const name of names.slice(0, 3)) {
    const params = new URLSearchParams({
      countrycode: cc,
      name,
      nameExact: 'true',
      hidebroken: 'true',
      order: 'bitrate',
      reverse: 'true',
      limit: String(RB_LIMIT),
    });

    const rows = await rbJson(`/json/stations/search?${params}`);
    for (const row of rows || []) {
      if (!exactStationNameMatch(station, row.name || '')) continue;
      for (const url of [row.url_resolved, row.url]) {
        if (!/^https?:\/\//i.test(url || '')) continue;
        found.push({
          url,
          codec: row.codec || '',
          bitrate: Number(row.bitrate) || 0,
          hls: Number(row.hls) || 0,
          source: 'radio-browser',
          identityConfidence: 92,
          stationuuid: row.stationuuid || '',
        });
      }
    }
    if (found.length) break;
  }

  return found;
}

async function probeCandidate(station, candidate, depth = 0) {
  if (depth > 2) throw new Error('playlist recursion limit');

  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  let response;

  try {
    response = await fetch(candidate.url, {
      redirect: 'follow',
      cache: 'no-store',
      headers: {
        'User-Agent': USER_AGENT,
        'Icy-MetaData': '1',
        Accept: 'audio/*,application/vnd.apple.mpegurl,application/x-mpegURL,*/*;q=0.5',
      },
      signal: controller.signal,
    });

    if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);

    const finalUrl = response.url || candidate.url;
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentType === 'text/html' || contentType === 'application/json') {
      throw new Error(`not audio: ${contentType}`);
    }

    const icyName = (response.headers.get('icy-name') || response.headers.get('x-audiocast-name') || '').trim();
    if (icyName && !exactStationNameMatch(station, icyName) && metadataLooksLikeKnownOtherStation(station, icyName)) {
      throw new Error(`identity mismatch: ${icyName}`);
    }

    const identityConfidence = icyName && exactStationNameMatch(station, icyName)
      ? 100
      : Number(candidate.identityConfidence) || 0;

    const playlistType = /mpegurl|scpls|xspf|audio\/m3u|audio\/x-m3u/.test(contentType);
    const urlLooksPlaylist = /\.(?:m3u8?|pls|xspf)(?:$|[?#])/i.test(finalUrl);

    if (playlistType || urlLooksPlaylist) {
      const text = await response.text();
      if (looksLikeHls(text) || /\.m3u8(?:$|[?#])/i.test(finalUrl)) {
        const best = parseHlsBestAudio(text, finalUrl);
        const stream = {
          ...candidate,
          url: best?.url || finalUrl,
          finalUrl: best?.url || finalUrl,
          codec: best?.codec || candidate.codec || 'AAC',
          bitrate: best?.bitrate || candidate.bitrate || 0,
          hls: 1,
          identityConfidence,
          latencyMs: Math.round(performance.now() - started),
          verifiedAt: new Date().toISOString(),
        };
        stream.score = streamScore(stream);
        return stream;
      }

      const entries = parsePlaylistByType(text, contentType, finalUrl);
      if (!entries.length) throw new Error('playlist has no stream URL');
      return await probeCandidate(station, { ...candidate, url: entries[0].url, identityConfidence }, depth + 1);
    }

    let bytes = new Uint8Array();
    if (response.body) bytes = await readLimited(response.body, PROBE_BYTES);

    const audioInfo = parseIceAudioInfo(response.headers.get('ice-audio-info') || response.headers.get('icy-audio-info') || '');
    const raw = inspectAudioBytes(bytes, contentType, candidate.codec || '');
    const codec = raw.codec || codecFromContentType(contentType, candidate.codec || '') || candidate.codec || '';
    const bitrate = raw.bitrate || Number(response.headers.get('icy-br')) || audioInfo.bitrate || Number(candidate.bitrate) || 0;
    const sampling = raw.sampling || audioInfo.sampling || Number(candidate.sampling) || 0;
    const bitDepth = raw.bitDepth || Number(candidate.bitDepth) || 0;

    const stream = {
      ...candidate,
      url: finalUrl,
      finalUrl,
      codec,
      bitrate,
      sampling,
      bitDepth,
      hls: 0,
      identityConfidence,
      icyName,
      latencyMs: Math.round(performance.now() - started),
      verifiedAt: new Date().toISOString(),
    };
    stream.score = streamScore(stream);
    return stream;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    try { await response?.body?.cancel(); } catch {}
  }
}

function metadataLooksLikeKnownOtherStation(current, icyName) {
  return stations.some((other) => {
    if (other.id === current.id) return false;
    const sameMarket = other.countrycode === current.countrycode
      || (current.countrycode === 'HQ' && other.originCountrycode === current.originCountrycode);
    return sameMarket && exactStationNameMatch(other, icyName);
  });
}

async function discoverRadioBrowserServers() {
  try {
    const rows = await dns.resolveSrv('_api._tcp.radio-browser.info');
    const hosts = rows.map((row) => row.name.replace(/\.$/, '')).filter(Boolean);
    if (hosts.length) return [...new Set(hosts)].map((host) => `https://${host}`);
  } catch {}

  return [
    'https://de2.api.radio-browser.info',
    'https://fi1.api.radio-browser.info',
    'https://de1.api.radio-browser.info',
  ];
}

async function rbJson(path) {
  let lastError;
  for (const base of shuffle(rbServers)) {
    try {
      return JSON.parse(await fetchText(`${base}${path}`, 4500));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Radio Browser unavailable');
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function readLimited(body, limit) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (total < limit) {
      const { value, done } = await reader.read();
      if (done || !value?.length) break;
      const take = Math.min(value.length, limit - total);
      chunks.push(value.subarray(0, take));
      total += take;
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
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

function assertUniqueStationIds(items) {
  const seen = new Set();
  for (const station of items) {
    if (!station?.id) throw new Error('Station without id');
    if (seen.has(station.id)) throw new Error(`Duplicate station id: ${station.id}`);
    seen.add(station.id);
  }
}

function shuffle(values) {
  return [...values].sort(() => Math.random() - 0.5);
}
