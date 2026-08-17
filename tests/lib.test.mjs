import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeName,exactStationNameMatch,parseM3u,parsePls,parseHlsBestAudio,parseFlacStreamInfo,streamScore,dedupeStreams} from '../scripts/lib.mjs';

test('station identity is accent/case tolerant but exact',()=>{
  const s={name:'Fréquence 3 Gold',aliases:['Frequence 3 Gold']};
  assert.equal(exactStationNameMatch(s,'FREQUENCE 3 GOLD'),true);
  assert.equal(exactStationNameMatch(s,'Fréquence 3 Dance'),false);
  assert.equal(normalizeName('M-1 Plius'),'m1plius');
});

test('M3U and PLS parse direct URLs',()=>{
  assert.deepEqual(parseM3u('#EXTM3U\n#EXTINF:-1,Test\nhttps://example.com/live.mp3'),[{name:'Test',url:'https://example.com/live.mp3'}]);
  assert.deepEqual(parsePls('[playlist]\nFile1=/live\nTitle1=Test','https://example.com/a.pls'),[{name:'Test',url:'https://example.com/live'}]);
});

test('HLS chooses highest audio-only rendition',()=>{
  const text='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\na128.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=320000,CODECS="mp4a.40.2"\na320.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.4d401f,mp4a.40.2"\nvideo.m3u8';
  assert.deepEqual(parseHlsBestAudio(text,'https://x.test/master.m3u8'),{url:'https://x.test/a320.m3u8',codec:'AAC',bitrate:320});
});

test('FLAC STREAMINFO yields sample rate and bit depth',()=>{
  const b=new Uint8Array(42); b.set([0x66,0x4c,0x61,0x43,0x00,0x00,0x00,0x22],0);
  const d=18; const rate=48000, depthMinus1=23;
  b[d]=(rate>>12)&0xff; b[d+1]=(rate>>4)&0xff; b[d+2]=((rate&0xf)<<4)|((depthMinus1>>4)&1); b[d+3]=(depthMinus1&0xf)<<4;
  const info=parseFlacStreamInfo(b); assert.equal(info.sampling,48000); assert.equal(info.bitDepth,24);
});

test('quality-first scoring prefers lossless then AAC then MP3',()=>{
  const flac=streamScore({codec:'FLAC',sampling:44100,bitDepth:16,source:'curated'});
  const aac=streamScore({codec:'AAC',bitrate:256,source:'curated'});
  const mp3=streamScore({codec:'MP3',bitrate:320,source:'curated'});
  assert.ok(flac>aac); assert.ok(aac>mp3);
});

test('dedupe keeps stronger candidate for same URL',()=>{
  const rows=dedupeStreams([{url:'https://x.test/live',codec:'MP3',bitrate:128},{url:'https://x.test/live',codec:'MP3',bitrate:320}]);
  assert.equal(rows.length,1); assert.equal(rows[0].bitrate,320);
});
