import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'target']);
const ignoredFiles = new Set(['pnpm-lock.yaml', 'Cargo.lock']);
const textExtensions = new Set(['', '.css', '.html', '.json', '.key', '.md', '.minisign', '.mjs', '.pem', '.rs', '.sh', '.toml', '.ts', '.tsx', '.yaml', '.yml']);
const signatures = [
  ['OpenRouter API key', /\bsk-or-v1-[A-Za-z0-9_-]{20,}\b/],
  ['Brave Search API key', /\bBSA[A-Za-z0-9]{20,}\b/],
  ['fal.ai API key', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{32}\b/i],
  ['private PEM key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=]{40,}/],
  ['private Minisign key', /untrusted comment:\s*minisign secret key[^\n]*\n\s*[A-Za-z0-9+/=]{40,}/i],
];

const findings = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await walk(path); continue; }
    if (!entry.isFile() || ignoredFiles.has(entry.name) || !textExtensions.has(extname(entry.name))) continue;
    const content = await readFile(path, 'utf8').catch(() => '');
    for (const [label, pattern] of signatures) if (pattern.test(content)) findings.push(`${relative(root, path)}: ${label}`);
  }
}

await walk(root);
if (findings.length) throw new Error(`Possible committed secrets detected:\n${findings.join('\n')}`);
process.stdout.write('Verified: no known provider or updater private-key patterns in repository text files.\n');
