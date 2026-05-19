import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const blockedTerms = [
  "san" + "kuai",
  "r" + ".npm",
  "dev" + ".san" + "kuai",
  "km" + ".san" + "kuai",
  "Fri" + "day",
  "美" + "团"
];

const ignoredDirs = new Set([".git", ".gitnexus", "dist", "node_modules"]);
const ignoredFiles = new Set(["FILES.json", "FILES.notes.json"]);

const hits = [];

async function scan(target) {
  const info = await stat(target);
  if (info.isDirectory()) {
    if (ignoredDirs.has(path.basename(target))) {
      return;
    }
    for (const entry of await readdir(target)) {
      await scan(path.join(target, entry));
    }
    return;
  }

  if (!info.isFile() || ignoredFiles.has(path.basename(target))) {
    return;
  }

  let text;
  try {
    text = await readFile(target, "utf8");
  } catch {
    return;
  }

  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (blockedTerms.some((term) => line.toLowerCase().includes(term.toLowerCase()))) {
      hits.push(`${target}:${index + 1}: ${line.trim()}`);
    }
  });
}

await scan(process.cwd());

if (hits.length > 0) {
  console.error("Internal source references found:");
  console.error(hits.join("\n"));
  process.exit(1);
}
