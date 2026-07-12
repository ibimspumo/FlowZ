import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const dist = new URL("../dist/", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL(".vite/manifest.json", dist), "utf8"),
);
const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry);
if (!entryKey) throw new Error("Vite entry is missing from the manifest.");

const bytes = async (file) => (await stat(join(dist.pathname, file))).size;
const entry = manifest[entryKey];
const eager = new Set();
const visitEager = (key) => {
  if (eager.has(key)) return;
  eager.add(key);
  for (const imported of manifest[key]?.imports ?? []) visitEager(imported);
};
visitEager(entryKey);

const lazySources = {
  fonts: "src/nodes/brand/fonts.ts",
  fontPicker: "src/components/FontPicker.tsx",
  markdown: "src/components/MarkdownView.tsx",
  brandArtifact: "src/components/BrandArtifactView.tsx",
};
for (const [owner, source] of Object.entries(lazySources)) {
  const chunk = manifest[source];
  if (!chunk?.isDynamicEntry)
    throw new Error(`${owner} is no longer a dynamic Vite entry.`);
  if (eager.has(source))
    throw new Error(`${owner} (${source}) leaked into the eager import graph.`);
}

const measured = {
  main: await bytes(entry.file),
  css: await Promise.all((entry.css ?? []).map(bytes)).then((items) =>
    items.reduce((sum, value) => sum + value, 0),
  ),
  fonts: await bytes(manifest[lazySources.fonts].file),
  markdown: await bytes(manifest[lazySources.markdown].file),
  fontPicker: await bytes(manifest[lazySources.fontPicker].file),
};
const baseline = { main: 843_258, css: 84_730 };
const budgets = {
  main: 875_000,
  css: 90_000,
  fonts: 2_150_000,
  markdown: 170_000,
  fontPicker: 20_000,
};
for (const [asset, limit] of Object.entries(budgets)) {
  if (measured[asset] > limit)
    throw new Error(`${asset} bundle is ${measured[asset]} bytes; budget is ${limit}.`);
}

const html = await readFile(new URL("index.html", dist), "utf8");
for (const source of Object.values(lazySources)) {
  const file = manifest[source].file;
  if (html.includes(file)) throw new Error(`${file} is requested by index.html.`);
}

console.log(JSON.stringify({ baseline, budgets, measured, eager: [...eager] }));
