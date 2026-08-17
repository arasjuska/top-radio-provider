# Top Radio Provider

Free, quality-first radio stream provider for **Top Radio Pro**.

The browser extension should not discover radio URLs live on every click. This repository does that work ahead of time on GitHub Actions and publishes a small verified dataset.

## Provider endpoint

`https://raw.githubusercontent.com/arasjuska/top-radio-provider/master/dist/stations.json`

Health/status:

`https://raw.githubusercontent.com/arasjuska/top-radio-provider/master/dist/status.json`

## How it works

1. Start from manually curated/official streams in `data/stations.lt.json`, `data/stations.it.json`, `data/stations.ru.json` and `data/stations.hq.json`.
2. Add exact-name candidates from IPRD.
3. Add exact-name candidates from Radio Browser using its mirror network.
4. Probe every candidate: redirects, HTTP status, content type, playlists, ICY metadata, codec, bitrate, sample rate and lossless metadata when available.
5. Reject obvious identity conflicts and non-audio responses.
6. Rank the remaining streams quality-first: lossless/Hi-Res before high-quality AAC/Opus, then MP3.
7. Publish only the best verified stream plus up to three verified fallbacks per station.

The extension should treat this repository as a provider, not as an infallible source: it should still fail closed if a selected URL cannot be played.

## Sources and licensing

- Curated/official stream URLs: maintained in this repository for the Top Radio Pro station set.
- Radio Browser: free/open-source and permits mirroring its data.
- IPRD: curated public radio stream playlists, MIT licensed.

No FMSTREAM API data is mirrored here because its free API terms do not allow building a redistributable stream database from its data.

## Automation

`.github/workflows/update-provider.yml` runs every 6 hours and on relevant source/code changes. A failed validation run does **not** overwrite the last known-good provider file.

## Local

```bash
npm test
npm run build
```

Node.js 22+; no third-party runtime dependencies.
