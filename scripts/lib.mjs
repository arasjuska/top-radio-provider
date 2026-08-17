export function normalizeName(value = '') {
  return value
    .toString()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

export function stationSignatures(station) {
  return new Set([station?.name, ...(station?.aliases || [])].map(normalizeName).filter((v) => v.length >= 2));
}

export function exactStationNameMatch(station, candidateName) {
  const candidate = normalizeName(candidateName);
  return Boolean(candidate && stationSignatures(station).has(candidate));
}

export function parseM3u(text = '', baseUrl = '') {
  const entries = [];
  let pendingName = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const comma = line.indexOf(',');
      pendingName = comma >= 0 ? line.slice(comma + 1).trim() : '';
      continue;
    }
    if (line.startsWith('#')) continue;
    let url = line;
    try { url = new URL(line, baseUrl || undefined).toString(); } catch {}
    if (/^https?:\/\//i.test(url)) entries.push({ name: pendingName, url });
    pendingName = '';
  }
  return entries;
}

export function parsePls(text = '', baseUrl = '') {
  const urls = [];
  const titles = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    let match = line.match(/^Title(\d+)=(.*)$/i);
    if (match) { titles.set(match[1], match[2].trim()); continue; }
    match = line.match(/^File(\d+)=(.*)$/i);
    if (!match) continue;
    let url = match[2].trim();
    try { url = new URL(url, baseUrl || undefined).toString(); } catch {}
    if (/^https?:\/\//i.test(url)) urls.push({ index: match[1], url });
  }
  return urls.map(({ index, url }) => ({ name: titles.get(index) || '', url }));
}

export function parsePlaylistByType(text, contentType = '', baseUrl = '') {
  const type = contentType.toLowerCase();
  if (type.includes('scpls')) return parsePls(text, baseUrl);
  return parseM3u(text, baseUrl);
}

export function looksLikeHls(text = '') {
  return /#EXT-X-(?:STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE|PLAYLIST-TYPE|I-FRAME-STREAM-INF|MEDIA:)/i.test(text);
}

export function parseHlsBestAudio(text = '', baseUrl = '') {
  const lines = text.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
  let best = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attrs = parseHlsAttrs(line.slice('#EXT-X-STREAM-INF:'.length));
    const codecs = (attrs.CODECS || '').toLowerCase();
    const hasVideo = /(avc1|avc3|hev1|hvc1|vp0?9|av01|theora)/i.test(codecs);
    if (hasVideo) continue;
    const codec = codecFromHls(codecs);
    const bw = Number(attrs['AVERAGE-BANDWIDTH'] || attrs.BANDWIDTH || 0);
    const bitrate = bw > 0 ? Math.round(bw / 1000) : 0;
    let uri = '';
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!lines[j].startsWith('#')) { uri = lines[j]; break; }
    }
    if (!uri) continue;
    try { uri = new URL(uri, baseUrl).toString(); } catch { continue; }
    if (!best || bitrate > best.bitrate) best = { url: uri, codec, bitrate };
  }
  return best;
}

function parseHlsAttrs(value) {
  const result = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let m;
  while ((m = re.exec(value))) result[m[1].toUpperCase()] = m[2].replace(/^"|"$/g, '');
  return result;
}

function codecFromHls(value = '') {
  if (value.includes('flac')) return 'FLAC';
  if (value.includes('alac')) return 'ALAC';
  if (value.includes('opus')) return 'OPUS';
  if (value.includes('mp4a.69') || value.includes('mp4a.6b') || value.includes('mp3')) return 'MP3';
  if (value.includes('mp4a') || value.includes('aac')) return 'AAC';
  return '';
}

export function codecFromContentType(contentType = '', hint = '') {
  const type = contentType.toLowerCase();
  const h = hint.toUpperCase();
  if (type.includes('audio/flac') || type.includes('flac')) return 'FLAC';
  if (type.includes('audio/aac') || type.includes('aacp')) return 'AAC';
  if (type.includes('audio/mpeg')) return 'MP3';
  if (type.includes('opus')) return 'OPUS';
  if (type.includes('ogg')) {
    if (h.includes('FLAC')) return 'FLAC';
    if (h.includes('OPUS')) return 'OPUS';
    return h || 'OGG';
  }
  return h;
}

export function parseIceAudioInfo(value = '') {
  const result = { bitrate: 0, sampling: 0 };
  for (const part of value.split(/[;,]/)) {
    const [rawKey, rawValue] = part.split('=').map((v) => v?.trim());
    const key = (rawKey || '').toLowerCase();
    const n = Number(rawValue);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (key === 'bitrate' || key === 'bitrate_kbps') result.bitrate = n;
    if (key === 'samplerate' || key === 'sample_rate') result.sampling = n;
  }
  return result;
}

export function parseMp3FrameInfo(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes || []);
  const v1 = {
    1: [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320],
    2: [0,32,48,56,64,80,96,112,128,160,192,224,256,320,384],
    3: [0,32,64,96,128,160,192,224,256,288,320,352,384,416,448],
  };
  const v2 = {
    1: [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160],
    2: [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160],
    3: [0,32,48,56,64,80,96,112,128,144,160,176,192,224,256],
  };
  for (let o = 0; o <= bytes.length - 4; o += 1) {
    const b0=bytes[o], b1=bytes[o+1], b2=bytes[o+2];
    if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) continue;
    const version=(b1>>3)&3, layer=(b1>>1)&3, bi=(b2>>4)&15, si=(b2>>2)&3;
    if (version===1 || layer===0 || bi===0 || bi===15 || si===3) continue;
    const mpeg1=version===3;
    const bitrate=(mpeg1?v1:v2)[layer]?.[bi]||0;
    const rates=version===3?[44100,48000,32000]:version===2?[22050,24000,16000]:[11025,12000,8000];
    const sampling=rates[si]||0;
    if (bitrate && sampling) return { codec:'MP3', bitrate, sampling, bitDepth:0 };
  }
  return { codec:'', bitrate:0, sampling:0, bitDepth:0 };
}

export function parseAdtsInfo(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes || []);
  const rates=[96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
  let o=0,totalBytes=0,totalSamples=0,sampling=0,frames=0;
  while (o <= bytes.length-7 && frames < 16) {
    if (bytes[o]!==0xff || (bytes[o+1]&0xf6)!==0xf0) { o++; continue; }
    const idx=(bytes[o+2]>>2)&15, rate=rates[idx]||0;
    const len=((bytes[o+3]&3)<<11)|(bytes[o+4]<<3)|((bytes[o+5]&0xe0)>>5);
    const blocks=bytes[o+6]&3;
    if (!rate || len<7 || o+len>bytes.length) { o++; continue; }
    sampling ||= rate;
    if (sampling!==rate) break;
    totalBytes+=len; totalSamples+=1024*(blocks+1); frames++; o+=len;
  }
  if (frames<2 || !sampling || !totalSamples) return { codec:'', bitrate:0, sampling:0, bitDepth:0 };
  return { codec:'AAC', bitrate:Math.max(1,Math.round(totalBytes*8*sampling/totalSamples/1000)), sampling, bitDepth:0 };
}

export function parseFlacStreamInfo(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes || []);
  let marker=-1;
  for (let i=0;i<=bytes.length-4;i++) {
    if (bytes[i]===0x66&&bytes[i+1]===0x4c&&bytes[i+2]===0x61&&bytes[i+3]===0x43) { marker=i; break; }
  }
  if (marker<0 || marker+42>bytes.length) return { codec:'', bitrate:0, sampling:0, bitDepth:0 };
  const header=marker+4;
  const blockType=bytes[header]&0x7f;
  const length=(bytes[header+1]<<16)|(bytes[header+2]<<8)|bytes[header+3];
  if (blockType!==0 || length<34 || header+4+34>bytes.length) return { codec:'', bitrate:0, sampling:0, bitDepth:0 };
  const d=header+4+10;
  const sampling=(bytes[d]<<12)|(bytes[d+1]<<4)|(bytes[d+2]>>4);
  const bitDepth=(((bytes[d+2]&1)<<4)|(bytes[d+3]>>4))+1;
  return { codec:'FLAC', bitrate:0, sampling, bitDepth };
}

export function inspectAudioBytes(bytes, contentType = '', hint = '') {
  const type=contentType.toLowerCase();
  const h=hint.toUpperCase();
  if (type.includes('flac') || h.includes('FLAC') || h.includes('OGG FLAC')) {
    const flac=parseFlacStreamInfo(bytes); if (flac.sampling) return flac;
  }
  if (type.includes('aac') || h.includes('AAC')) {
    const aac=parseAdtsInfo(bytes); if (aac.bitrate) return aac;
  }
  const mp3=parseMp3FrameInfo(bytes); if (mp3.bitrate) return mp3;
  const aac=parseAdtsInfo(bytes); if (aac.bitrate) return aac;
  const flac=parseFlacStreamInfo(bytes); if (flac.sampling) return flac;
  return { codec:'', bitrate:0, sampling:0, bitDepth:0 };
}

export function streamScore(stream = {}) {
  const codec=(stream.codec||'').toUpperCase();
  const bitrate=Number(stream.bitrate)||0;
  const sampling=Number(stream.sampling)||0;
  const bitDepth=Number(stream.bitDepth)||0;
  let quality=0;
  if (/FLAC|ALAC/.test(codec)) quality=100000 + bitDepth*1000 + Math.min(384000,sampling)/10;
  else if (codec.includes('OPUS')) quality=60000 + bitrate*100;
  else if (codec.includes('AAC')) quality=55000 + bitrate*100;
  else if (/MP3|MPEG/.test(codec)) quality=45000 + bitrate*100;
  else quality=20000 + bitrate*50;
  const sourceBonus=stream.official?5000:stream.source==='curated'?3500:stream.source==='iprd'?2200:stream.source==='radio-browser'?1200:0;
  const identityBonus=(Number(stream.identityConfidence)||0)*30;
  const directBonus=stream.hls?0:600;
  const latencyPenalty=Math.min(1500,Math.round((Number(stream.latencyMs)||0)/5));
  return Math.round(quality+sourceBonus+identityBonus+directBonus-latencyPenalty);
}

export function dedupeStreams(streams = []) {
  const map=new Map();
  for (const stream of streams) {
    if (!stream?.url) continue;
    let key=stream.url;
    try {
      const u=new URL(stream.url); u.hash='';
      if (u.pathname.length>1) u.pathname=u.pathname.replace(/\/+$/, '');
      key=u.toString();
    } catch {}
    const existing=map.get(key);
    if (!existing || streamScore(stream)>streamScore(existing)) map.set(key, stream);
  }
  return [...map.values()];
}
