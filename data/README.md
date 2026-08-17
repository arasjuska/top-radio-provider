# Station source data

`stations.source.json` is the stable station identity layer used by Top Radio Pro.

Rules:

- `id` is our immutable station identifier.
- `aliases` are only for exact normalized identity matching; do not add broad/fuzzy names.
- `streams` contains official or manually curated candidates. Keep the highest known quality first, but the validator makes the final decision.
- HQ entries use `countrycode: "HQ"` and `originCountrycode` for external directory lookups.
- Do not add a URL just because a directory claims it belongs to a station. Prefer broadcaster-published URLs and verify redirects/metadata.
