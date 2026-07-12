import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const source = resolve(process.argv[2] ?? 'assets/icon/flowz-icon-master-1024.png');
const bytes = await readFile(source);
if (bytes.length < 24 || bytes.subarray(1, 4).toString() !== 'PNG') throw new Error('The icon master must be a PNG file.');
const width = bytes.readUInt32BE(16);
const height = bytes.readUInt32BE(20);
if (width !== 1024 || height !== 1024) throw new Error(`The icon master must be exactly 1024×1024 px; received ${width}×${height}.`);

await new Promise((resolvePromise, reject) => {
  const cli = resolve('node_modules/@tauri-apps/cli/tauri.js');
  const child = spawn(process.execPath, [cli, 'icon', source, '--output', 'src-tauri/icons'], { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`tauri icon exited with ${code}`)));
});
await mkdir('public', { recursive: true });
await copyFile('src-tauri/icons/128x128@2x.png', 'public/flowz-icon.png');
const trackedOutputs = [
  'src-tauri/icons/32x32.png',
  'src-tauri/icons/128x128.png',
  'src-tauri/icons/128x128@2x.png',
  'src-tauri/icons/icon.icns',
  'src-tauri/icons/icon.ico',
  'public/flowz-icon.png',
];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const manifest = {
  schemaVersion: 1,
  generator: '@tauri-apps/cli icon',
  master: { path: 'assets/icon/flowz-icon-master-1024.png', sha256: digest(bytes) },
  outputs: Object.fromEntries(
    await Promise.all(trackedOutputs.map(async (path) => [path, digest(await readFile(path))])),
  ),
};
await writeFile('assets/icon/icon-generation.json', `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write('Generated Tauri/macOS icons and public/flowz-icon.png from the 1024 px master.\n');
