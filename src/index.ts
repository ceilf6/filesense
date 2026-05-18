#!/usr/bin/env node
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

type CommandName = "init" | "sync" | "check" | "query";

type Config = {
  schemaVersion: string;
  root: string;
  recursive: boolean;
  indexFile: string;
  notesFile: string;
  ignoreFile: string;
  exclude: string[];
  hashAlgorithm: "sha1";
};

type ChildEntry = {
  name: string;
  type: "file" | "dir";
  path: string;
  ext: string;
  size: number;
  mtimeMs: number;
  hash: string | null;
  summary: string;
  importance: "high" | "normal";
  status: "active";
};

type IndexFile = {
  schema_version: string;
  generated_at: string;
  root_relative_path: string;
  directory: {
    name: string;
    path: string;
  };
  children: ChildEntry[];
  sync: {
    child_count: number;
    file_count: number;
    dir_count: number;
    last_full_sync: string | null;
    last_incremental_sync: string | null;
  };
};

type NotesFile = {
  directory_purpose?: string;
  agent_hints?: string[];
  conventions?: string[];
  key_entrypoints?: string[];
};

type ParsedArgs = {
  command: CommandName;
  targetPath: string;
  json: boolean;
  full: boolean;
};

type SyncSummary = {
  root: string;
  directoriesScanned: number;
  indexesWritten: number;
  filesHashed: number;
  directoriesSkipped: number;
};

type CheckSummary = {
  root: string;
  checkedDirectories: number;
  missingIndexes: string[];
  staleIndexes: string[];
  invalidIndexes: string[];
};

const DEFAULT_CONFIG: Config = {
  schemaVersion: "1.0",
  root: ".",
  recursive: true,
  indexFile: "FILES.json",
  notesFile: "FILES.notes.json",
  ignoreFile: ".filesignore",
  exclude: [".git", "node_modules", "dist", "build", ".next", "coverage"],
  hashAlgorithm: "sha1"
};

const INTERNAL_FILES = new Set(["FILES.json", "FILES.notes.json", ".filesrc.json"]);

async function main(): Promise<void> {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    switch (parsed.command) {
      case "init":
        await runInit(parsed);
        break;
      case "sync":
        await runSync(parsed);
        break;
      case "check":
        await runCheck(parsed);
        break;
      case "query":
        await runQuery(parsed);
        break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const [commandRaw, ...rest] = argv;
  if (!commandRaw || commandRaw === "--help" || commandRaw === "-h") {
    printHelp();
    process.exit(0);
  }

  if (!["init", "sync", "check", "query"].includes(commandRaw)) {
    throw new Error(`Unknown command: ${commandRaw}`);
  }

  let targetPath = ".";
  let json = false;
  let full = false;

  for (const arg of rest) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--full") {
      full = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      targetPath = arg;
    }
  }

  return {
    command: commandRaw as CommandName,
    targetPath,
    json,
    full
  };
}

function printHelp(): void {
  console.log(`filesense <command> [path]

Commands:
  init   Initialize .filesrc.json and .filesignore, then sync
  sync   Recursively write FILES.json indexes
  check  Validate FILES.json coverage and freshness
  query  Read FILES.json and optional FILES.notes.json

Options:
  --full  Recompute file hashes even if mtime/size are unchanged
  --json  Print machine-readable output`);
}

async function runInit(args: ParsedArgs): Promise<void> {
  const root = path.resolve(args.targetPath);
  await ensureDirectory(root);

  const configPath = path.join(root, ".filesrc.json");
  if (!(await exists(configPath))) {
    await writeJson(configPath, DEFAULT_CONFIG);
  }

  const ignorePath = path.join(root, ".filesignore");
  if (!(await exists(ignorePath))) {
    await fs.writeFile(ignorePath, defaultIgnoreContents(), "utf8");
  }

  const summary = await syncIndexes(root, true, false);
  printOutput(args.json, {
    action: "init",
    root,
    configPath,
    ignorePath,
    summary
  }, [
    `Initialized ${root}`,
    `Config: ${configPath}`,
    `Ignore rules: ${ignorePath}`,
    formatSyncSummary(summary)
  ]);
}

async function runSync(args: ParsedArgs): Promise<void> {
  const root = path.resolve(args.targetPath);
  const summary = await syncIndexes(root, false, args.full);
  printOutput(args.json, summary, [formatSyncSummary(summary)]);
}

async function runCheck(args: ParsedArgs): Promise<void> {
  const root = path.resolve(args.targetPath);
  const summary = await checkIndexes(root);
  const lines = [
    `Checked ${summary.checkedDirectories} directories under ${summary.root}`,
    `Missing indexes: ${summary.missingIndexes.length}`,
    `Stale indexes: ${summary.staleIndexes.length}`,
    `Invalid indexes: ${summary.invalidIndexes.length}`
  ];
  if (summary.missingIndexes.length > 0) {
    lines.push("Missing:");
    lines.push(...summary.missingIndexes.map((item) => `  ${item}`));
  }
  if (summary.staleIndexes.length > 0) {
    lines.push("Stale:");
    lines.push(...summary.staleIndexes.map((item) => `  ${item}`));
  }
  if (summary.invalidIndexes.length > 0) {
    lines.push("Invalid:");
    lines.push(...summary.invalidIndexes.map((item) => `  ${item}`));
  }
  printOutput(args.json, summary, lines);
}

async function runQuery(args: ParsedArgs): Promise<void> {
  const target = path.resolve(args.targetPath);
  const { root, config } = await resolveRootAndConfig(target);
  const relative = path.relative(root, target);
  const indexPath = path.join(target, config.indexFile);
  if (!(await exists(indexPath))) {
    throw new Error(`No ${config.indexFile} found in ${target}. Run sync first.`);
  }

  const index = (await readJson(indexPath)) as IndexFile;
  const notesPath = path.join(target, config.notesFile);
  const notes = (await exists(notesPath)) ? ((await readJson(notesPath)) as NotesFile) : null;

  printOutput(args.json, {
    root,
    target,
    rootRelativePath: relative === "" ? "." : relative,
    index,
    notes
  }, formatQuery(index, notes));
}

async function syncIndexes(targetPath: string, fromInit: boolean, forceFull: boolean): Promise<SyncSummary> {
  const { root, config, ignores } = await resolveRootAndConfig(targetPath);
  const summary: SyncSummary = {
    root,
    directoriesScanned: 0,
    indexesWritten: 0,
    filesHashed: 0,
    directoriesSkipped: 0
  };

  await walkDirectories(root, root, ignores, async (dirPath) => {
    summary.directoriesScanned += 1;
    const changedHashes = await writeDirectoryIndex(root, dirPath, config, forceFull);
    summary.filesHashed += changedHashes;
    summary.indexesWritten += 1;
  }, () => {
    summary.directoriesSkipped += 1;
  });

  if (!fromInit && summary.indexesWritten === 0) {
    throw new Error(`No directories were indexed under ${root}`);
  }

  return summary;
}

async function checkIndexes(targetPath: string): Promise<CheckSummary> {
  const { root, config, ignores } = await resolveRootAndConfig(targetPath);
  const summary: CheckSummary = {
    root,
    checkedDirectories: 0,
    missingIndexes: [],
    staleIndexes: [],
    invalidIndexes: []
  };

  await walkDirectories(root, root, ignores, async (dirPath) => {
    summary.checkedDirectories += 1;
    const indexPath = path.join(dirPath, config.indexFile);
    if (!(await exists(indexPath))) {
      summary.missingIndexes.push(relativeDisplay(root, dirPath));
      return;
    }

    let index: IndexFile;
    try {
      index = (await readJson(indexPath)) as IndexFile;
    } catch {
      summary.invalidIndexes.push(relativeDisplay(root, indexPath));
      return;
    }

    const actualEntries = await listTrackedEntries(root, dirPath, config, ignores);
    const indexedNames = new Set(index.children.map((entry) => entry.name));
    const actualNames = new Set(actualEntries.map((entry) => entry.name));
    if (!sameSet(indexedNames, actualNames)) {
      summary.staleIndexes.push(relativeDisplay(root, dirPath));
    }
  }, () => undefined);

  return summary;
}

async function writeDirectoryIndex(root: string, dirPath: string, config: Config, forceFull: boolean): Promise<number> {
  const indexPath = path.join(dirPath, config.indexFile);
  const previous = (await exists(indexPath)) ? ((await readJson(indexPath)) as IndexFile) : null;
  const previousMap = new Map(previous?.children.map((child) => [child.name, child]) ?? []);
  const entries = await listTrackedEntries(root, dirPath, config, await loadIgnoreMatcher(root, config));
  const children: ChildEntry[] = [];
  let filesHashed = 0;

  for (const entry of entries) {
    const absolutePath = path.join(dirPath, entry.name);
    const entrySize = Number(entry.stat.size);
    const entryMtimeMs = Number(entry.stat.mtimeMs);
    if (entry.type === "dir") {
      children.push({
        name: entry.name,
        type: "dir",
        path: relativeToRoot(root, absolutePath),
        ext: "",
        size: 0,
        mtimeMs: entryMtimeMs,
        hash: null,
        summary: "Directory",
        importance: "normal",
        status: "active"
      });
      continue;
    }

    const prev = previousMap.get(entry.name);
    let hash = prev?.hash ?? null;
    const unchanged = !forceFull
      && prev?.size === entrySize
      && prev?.mtimeMs === entryMtimeMs
      && prev?.type === "file";

    if (!unchanged) {
      hash = await hashFile(absolutePath, config.hashAlgorithm);
      filesHashed += 1;
    }

    children.push({
      name: entry.name,
      type: "file",
      path: relativeToRoot(root, absolutePath),
      ext: path.extname(entry.name),
      size: entrySize,
      mtimeMs: entryMtimeMs,
      hash,
      summary: prev?.summary ?? inferSummary(entry.name),
      importance: inferImportance(entry.name),
      status: "active"
    });
  }

  children.sort((a, b) => a.name.localeCompare(b.name));
  const timestamp = new Date().toISOString();
  const relativePath = relativeToRoot(root, dirPath);
  const nextIndex: IndexFile = {
    schema_version: config.schemaVersion,
    generated_at: timestamp,
    root_relative_path: relativePath,
    directory: {
      name: path.basename(dirPath),
      path: relativePath
    },
    children,
    sync: {
      child_count: children.length,
      file_count: children.filter((item) => item.type === "file").length,
      dir_count: children.filter((item) => item.type === "dir").length,
      last_full_sync: forceFull ? timestamp : previous?.sync.last_full_sync ?? null,
      last_incremental_sync: timestamp
    }
  };

  await writeJson(indexPath, nextIndex);
  return filesHashed;
}

async function listTrackedEntries(
  root: string,
  dirPath: string,
  config: Config,
  ignores: IgnoreMatcher
): Promise<Array<{ name: string; type: "file" | "dir"; stat: Awaited<ReturnType<typeof fs.stat>> }>> {
  const items = await fs.readdir(dirPath, { withFileTypes: true });
  const output: Array<{ name: string; type: "file" | "dir"; stat: Awaited<ReturnType<typeof fs.stat>> }> = [];

  for (const item of items) {
    if (item.name === config.indexFile || item.name === config.notesFile || item.name === config.ignoreFile) {
      continue;
    }
    if (INTERNAL_FILES.has(item.name)) {
      continue;
    }

    const absolutePath = path.join(dirPath, item.name);
    const relative = relativeToRoot(root, absolutePath);
    if (ignores(relative, item.isDirectory())) {
      continue;
    }
    if (!item.isFile() && !item.isDirectory()) {
      continue;
    }

    const stat = await fs.stat(absolutePath);
    output.push({
      name: item.name,
      type: item.isDirectory() ? "dir" : "file",
      stat
    });
  }

  return output;
}

async function walkDirectories(
  root: string,
  startDir: string,
  ignores: IgnoreMatcher,
  onDirectory: (dirPath: string) => Promise<void>,
  onSkip: () => void
): Promise<void> {
  await onDirectory(startDir);

  const items = await fs.readdir(startDir, { withFileTypes: true });
  for (const item of items) {
    if (!item.isDirectory()) {
      continue;
    }
    const absolutePath = path.join(startDir, item.name);
    const relative = relativeToRoot(root, absolutePath);
    if (ignores(relative, true)) {
      onSkip();
      continue;
    }
    await walkDirectories(root, absolutePath, ignores, onDirectory, onSkip);
  }
}

type IgnoreMatcher = (relativePath: string, isDirectory: boolean) => boolean;

async function resolveRootAndConfig(targetPath: string): Promise<{ root: string; config: Config; ignores: IgnoreMatcher }> {
  const root = await findConfigRoot(targetPath);
  const configPath = path.join(root, ".filesrc.json");
  const config = (await exists(configPath))
    ? ({ ...DEFAULT_CONFIG, ...((await readJson(configPath)) as Partial<Config>) } satisfies Config)
    : DEFAULT_CONFIG;
  const ignores = await loadIgnoreMatcher(root, config);
  return { root, config, ignores };
}

async function findConfigRoot(startPath: string): Promise<string> {
  let current = path.resolve(startPath);
  const stat = await fs.stat(current);
  if (stat.isFile()) {
    current = path.dirname(current);
  }
  const initialDir = current;

  while (true) {
    if (await exists(path.join(current, ".filesrc.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return initialDir;
    }
    current = parent;
  }
}

async function loadIgnoreMatcher(root: string, config: Config): Promise<IgnoreMatcher> {
  const patterns = new Set(config.exclude);
  const ignorePath = path.join(root, config.ignoreFile);
  if (await exists(ignorePath)) {
    const raw = await fs.readFile(ignorePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const normalized = line.trim();
      if (!normalized || normalized.startsWith("#")) {
        continue;
      }
      patterns.add(normalized.replace(/^\.\//, ""));
    }
  }

  return (relativePath: string, isDirectory: boolean): boolean => {
    const normalized = relativePath.replace(/\\/g, "/");
    const parts = normalized.split("/");
    for (const pattern of patterns) {
      const clean = pattern.replace(/\\/g, "/");
      if (clean.endsWith("/")) {
        const prefix = clean.slice(0, -1);
        if (normalized === prefix || normalized.startsWith(prefix + "/")) {
          return true;
        }
      } else if (clean.includes("/")) {
        if (normalized === clean || normalized.startsWith(clean + "/")) {
          return true;
        }
      } else if (parts.includes(clean)) {
        return true;
      } else if (!isDirectory && path.basename(normalized) === clean) {
        return true;
      }
    }
    return false;
  };
}

async function ensureDirectory(targetPath: string): Promise<void> {
  const stat = await fs.stat(targetPath).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Not a directory: ${targetPath}`);
  }
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(targetPath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(targetPath, "utf8")) as unknown;
}

async function writeJson(targetPath: string, value: unknown): Promise<void> {
  await fs.writeFile(targetPath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function hashFile(targetPath: string, algorithm: "sha1"): Promise<string> {
  const buffer = await fs.readFile(targetPath);
  return `${algorithm}:${createHash(algorithm).update(buffer).digest("hex")}`;
}

function relativeToRoot(root: string, targetPath: string): string {
  const relative = path.relative(root, targetPath).replace(/\\/g, "/");
  return relative === "" ? "." : relative;
}

function relativeDisplay(root: string, targetPath: string): string {
  return relativeToRoot(root, targetPath);
}

function inferSummary(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") {
    return "TypeScript source file";
  }
  if (ext === ".js" || ext === ".jsx") {
    return "JavaScript source file";
  }
  if (ext === ".json") {
    return "JSON data file";
  }
  if (ext === ".md") {
    return "Markdown document";
  }
  if (ext === ".sh") {
    return "Shell script";
  }
  if (ext === ".yml" || ext === ".yaml") {
    return "YAML configuration file";
  }
  if (!ext) {
    return "File without extension";
  }
  return `${ext.slice(1).toUpperCase()} file`;
}

function inferImportance(name: string): "high" | "normal" {
  if (/^(readme|package|tsconfig|index|main)\./i.test(name)) {
    return "high";
  }
  return "normal";
}

function formatSyncSummary(summary: SyncSummary): string {
  return `Synced ${summary.directoriesScanned} directories, wrote ${summary.indexesWritten} indexes, hashed ${summary.filesHashed} files, skipped ${summary.directoriesSkipped} directories`;
}

function formatQuery(index: IndexFile, notes: NotesFile | null): string[] {
  const lines = [
    `Directory: ${index.directory.path}`,
    `Children: ${index.sync.child_count} (${index.sync.file_count} files, ${index.sync.dir_count} dirs)`
  ];
  if (notes?.directory_purpose) {
    lines.push(`Purpose: ${notes.directory_purpose}`);
  }
  if (notes?.key_entrypoints?.length) {
    lines.push(`Entrypoints: ${notes.key_entrypoints.join(", ")}`);
  }
  lines.push("Top entries:");
  for (const child of index.children.slice(0, 12)) {
    lines.push(`  - ${child.name} [${child.type}] ${child.summary}`);
  }
  return lines;
}

function printOutput(json: boolean, payload: unknown, lines: string[]): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(lines.join("\n"));
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const item of left) {
    if (!right.has(item)) {
      return false;
    }
  }
  return true;
}

function defaultIgnoreContents(): string {
  return [
    "# One pattern per line",
    "# Bare names match any path segment",
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    "coverage"
  ].join("\n") + "\n";
}

void main();
