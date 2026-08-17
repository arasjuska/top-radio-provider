import fs from 'node:fs/promises';
import { streamScore } from './lib.mjs';

const DIST_PATH = new URL('../dist/stations.json', import.meta.url);
const payload = JSON.parse(await fs.readFile(DIST_PATH, 'utf8'));

for (const station of payload.stations || []) {
  const streams = [station.best, ...(station.fallbacks || [])].filter(Boolean).map(sanitizeStream);
  streams.sort((a, b) => b.score - a.score);
  station.best = streams[0] || null;
  station.fallbacks = streams.slice(1, 4);
}

await fs.writeFile(DIST_PATH, `${JSON.stringify(payload, null, 2)}\n`);
console.log('Sanitized HLS audio metadata and re-ranked provider streams.');

function sanitizeStream(stream) {
  const next = { ...stream };
  const codec = String(next.codec || '').toUpperCase();
  const bitrate = Number(next.bitrate) || 0;
  const knownAudio = /^(AAC|AAC\+|HE-AAC|MP3|MPEG|OPUS|VORBIS|OGG|FLAC|ALAC)$/.test(codec);

  if (Number(next.hls) === 1) {
    if (!knownAudio || codec === 'UNKNOWN') {
      next.codec = '';
      next.bitrate = 0;
    } else if (!/FLAC|ALAC/.test(codec) && bitrate > 768) {
      next.bitrate = 0;
    }
  }

  next.score = streamScore(next);
  return next;
}
