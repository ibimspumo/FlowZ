#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';

const COMMIT = 'ec0464b978de222073645d6d3366f3fdf03376d8';
const repository = process.argv[2];
const output = new URL('../src/nodes/brand/google-fonts.catalog.json', import.meta.url);
if (!repository) throw new Error('Usage: node scripts/generate-google-fonts-catalog.mjs /path/to/google-fonts');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
if (head !== COMMIT) throw new Error(`Expected google/fonts ${COMMIT}, got ${head}`);

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const quoted = (line, key) => line.match(new RegExp(`^${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"$`))?.[1]?.replace(/\\"/g, '"');
const number = (line, key) => { const value = line.match(new RegExp(`^${key}:\\s*(-?[0-9.]+)$`))?.[1]; return value == null ? undefined : Number(value); };
const rawUrl = (path) => `https://raw.githubusercontent.com/google/fonts/${COMMIT}/${path.split('/').map(encodeURIComponent).join('/')}`;

function blocks(lines, name) {
  const result = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== `${name} {`) continue;
    const body = []; let depth = 1;
    for (index += 1; index < lines.length && depth; index += 1) {
      const line = lines[index].trim();
      if (line.endsWith('{')) depth += 1;
      if (line === '}') depth -= 1;
      if (depth) body.push(line);
    }
    result.push(body);
    index -= 1;
  }
  return result;
}

function parseMetadata(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const first = (key) => lines.map((line) => quoted(line, key)).find((value) => value != null);
  const variants = blocks(lines, 'fonts').map((body) => ({
    style: body.map((line) => quoted(line, 'style')).find(Boolean) ?? 'normal',
    weight: body.map((line) => number(line, 'weight')).find((value) => value != null) ?? 400,
    file: body.map((line) => quoted(line, 'filename')).find(Boolean),
  })).filter((variant) => variant.file).map((variant) => ({ ...variant, variable: variant.file.includes('[') }));
  const axes = blocks(lines, 'axes').map((body) => ({
    tag: body.map((line) => quoted(line, 'tag')).find(Boolean),
    min: body.map((line) => number(line, 'min_value')).find((value) => value != null),
    max: body.map((line) => number(line, 'max_value')).find((value) => value != null),
  })).filter((axis) => axis.tag && axis.min != null && axis.max != null);
  return {
    family: first('name'), license: first('license'), category: first('category'),
    subsets: lines.map((line) => quoted(line, 'subsets')).filter(Boolean), variants, axes,
  };
}

const families = [];
for (const licenseRoot of ['ofl', 'apache', 'ufl']) {
  const root = join(repository, licenseRoot);
  if (!existsSync(root)) continue;
  for (const directory of (await readdir(root, { withFileTypes: true })).filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const folder = join(root, directory.name); const metadataPath = join(folder, 'METADATA.pb');
    if (!existsSync(metadataPath)) continue;
    const metadata = await readFile(metadataPath); const parsed = parseMetadata(metadata.toString('utf8'));
    const licenseFile = ['OFL.txt', 'LICENSE.txt', 'UFL.txt'].find((name) => existsSync(join(folder, name)));
    if (!parsed.family || !parsed.license || !parsed.category || !parsed.variants.length) throw new Error(`Incomplete metadata: ${relative(repository, folder)}`);
    const path = relative(repository, folder).replaceAll('\\', '/'); const licenseBytes = licenseFile ? await readFile(join(folder, licenseFile)) : undefined;
    const variants = parsed.variants.map((variant) => ({ ...variant, url: rawUrl(`${path}/${variant.file}`) }));
    const selected = [...variants].sort((a, b) => Number(b.variable) - Number(a.variable) || Number(a.style !== 'normal') - Number(b.style !== 'normal') || Math.abs(a.weight - 400) - Math.abs(b.weight - 400))[0];
    families.push({
      family: parsed.family,
      category: parsed.category.toLowerCase().replace('_', '-'),
      license: parsed.license,
      path,
      subsets: [...new Set(parsed.subsets)].sort(),
      axes: parsed.axes,
      variants,
      defaultVariant: variants.indexOf(selected),
      metadataUrl: rawUrl(`${path}/METADATA.pb`), metadataSha256: hash(metadata),
      licenseUrl: licenseFile ? rawUrl(`${path}/${licenseFile}`) : null, licenseSha256: licenseBytes ? hash(licenseBytes) : null,
    });
  }
}
families.sort((a, b) => a.family.localeCompare(b.family));
const catalog = { version: 3, repository: 'https://github.com/google/fonts', commit: COMMIT, generatedAt: '2026-07-12', hashPolicy: 'Font binaries are not bundled; SHA-256 is computed and persisted after the pinned file is downloaded.', families };
await writeFile(output, `${JSON.stringify(catalog)}\n`);
process.stdout.write(`Generated ${families.length} families from google/fonts ${COMMIT}\n`);
