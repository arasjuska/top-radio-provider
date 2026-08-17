import fs from 'node:fs/promises';

const CATALOG = new URL('../dist/catalog/', import.meta.url);
const COUNTRIES = new URL('../dist/catalog/countries/', import.meta.url);
const MANIFEST = new URL('../dist/catalog/manifest.json', import.meta.url);

const files = (await fs.readdir(CATALOG, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'manifest.json')
  .map((entry) => entry.name);

const byCountry = new Map();
const seen = new Set();

for (const file of files) {
  const payload = JSON.parse(await fs.readFile(new URL(file, CATALOG), 'utf8'));
  for (const station of payload?.stations || []) {
    const code = String(station?.countrycode || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code) || !station?.id || !station?.name) continue;
    const key = `${code}|${station.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byCountry.has(code)) byCountry.set(code, []);
    byCountry.get(code).push(station);
  }
}

const manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
const generatedAt = manifest.generatedAt || new Date().toISOString();

await fs.rm(COUNTRIES, { recursive: true, force: true });
await fs.mkdir(COUNTRIES, { recursive: true });

const countries = [];
for (const [code, stations] of [...byCountry.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  stations.sort((a, b) => (Number(b.q) || 0) - (Number(a.q) || 0) || a.name.localeCompare(b.name));
  await fs.writeFile(new URL(`${code.toLowerCase()}.json`, COUNTRIES), JSON.stringify({ generatedAt, countrycode: code, stations }));
  countries.push({ code, count: stations.length });
}

manifest.countries = countries;
manifest.countryShards = countries.length;
await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Country index built: ${countries.length} countries, ${seen.size} unique stations.`);
