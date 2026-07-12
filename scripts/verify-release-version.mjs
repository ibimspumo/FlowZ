import { readFile } from 'node:fs/promises';

const [packageJson, tauriConfig, cargoToml, cargoLock] = await Promise.all([
  readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8'),
  readFile(new URL('../src-tauri/Cargo.lock', import.meta.url), 'utf8'),
]);

const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1];
const cargoLockVersion = /\[\[package\]\]\s+name\s*=\s*"flowz"\s+version\s*=\s*"([^"]+)"/m.exec(cargoLock)?.[1];
const versions = new Map([
  ['package.json', packageJson.version],
  ['src-tauri/tauri.conf.json', tauriConfig.version],
  ['src-tauri/Cargo.toml', cargoVersion],
  ['src-tauri/Cargo.lock', cargoLockVersion],
]);
const expected = packageJson.version;
const invalid = [...versions].filter(([, version]) => version !== expected);
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected) || invalid.length) {
  throw new Error(`Release versions differ: ${[...versions].map(([file, version]) => `${file}=${version ?? 'missing'}`).join(', ')}`);
}

const tag = process.env.GITHUB_REF_TYPE === 'tag'
  ? process.env.GITHUB_REF_NAME
  : process.argv.find((argument) => argument.startsWith('v'));
if (tag && tag !== `v${expected}`) throw new Error(`Tag ${tag} must exactly match v${expected}.`);
if (tag && expected.includes('-')) {
  throw new Error('Prerelease versions must not use the stable FlowZ release and updater workflow.');
}

console.log(`Release version ${expected} is consistent.`);
