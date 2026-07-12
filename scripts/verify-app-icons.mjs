import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

async function pngDimensions(path) {
  const bytes = await readFile(path);
  if (bytes.length < 24 || bytes.subarray(1, 4).toString() !== 'PNG') throw new Error(`${path} is not a PNG.`);
  return { bytes, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const master = await pngDimensions('assets/icon/flowz-icon-master-1024.png');
if (master.width !== 1024 || master.height !== 1024) throw new Error('The icon master must be exactly 1024×1024 px.');
const generated = await Promise.all([
  pngDimensions('src-tauri/icons/32x32.png'),
  pngDimensions('src-tauri/icons/128x128.png'),
  pngDimensions('src-tauri/icons/128x128@2x.png'),
  readFile('src-tauri/icons/icon.icns'),
  readFile('src-tauri/icons/icon.ico'),
]);
if (generated[0].width !== 32 || generated[1].width !== 128 || generated[2].width !== 256) throw new Error('Generated PNG icon dimensions are invalid.');
const web = await readFile('public/flowz-icon.png');
const digest = (value) => createHash('sha256').update(value).digest('hex');
if (digest(web) !== digest(generated[2].bytes)) throw new Error('Web icon differs from the generated 256 px Tauri icon.');
const manifest = JSON.parse(await readFile('assets/icon/icon-generation.json', 'utf8'));
if (manifest?.schemaVersion !== 1 || manifest?.master?.path !== 'assets/icon/flowz-icon-master-1024.png') {
  throw new Error('Icon generation manifest is missing or unsupported.');
}
if (manifest.master.sha256 !== digest(master.bytes)) {
  throw new Error('Icon master changed without regenerating platform icons. Run pnpm icons.');
}
for (const [path, expected] of Object.entries(manifest.outputs ?? {})) {
  if (digest(await readFile(path)) !== expected) throw new Error(`${path} differs from the generated icon manifest.`);
}
process.stdout.write('Verified 1024 px master plus generated macOS, Tauri and web icon assets.\n');
