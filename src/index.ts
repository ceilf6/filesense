#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

type CommandName = "init" | "sync" | "check" | "query" | "summarize" | "watch";

type Config = {
  schemaVersion: string;
  root: string;
  recursive: boolean;
  indexFile: string;
  notesFile: string;
  ignoreFile: string;
  schemaDir: string;
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
  $schema?: string;
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
  $schema?: string;
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
  force: boolean;
  intervalMs: number;
  maxDepth: number;
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
  invalidNotes: string[];
  missingSchemas: string[];
};

type SummarizeSummary = {
  root: string;
  directoriesScanned: number;
  notesWritten: number;
  notesSkipped: number;
};

type WriteIndexResult = {
  filesHashed: number;
  wroteIndex: boolean;
};

type SchemaPaths = {
  indexSchemaPath: string;
  notesSchemaPath: string;
};

type ComparableIndex = {
  $schema?: string;
  schema_version: string;
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
  };
};

const DEFAULT_CONFIG: Config = {
  schemaVersion: "1.0",
  root: ".",
  recursive: true,
  indexFile: "FILES.json",
  notesFile: "FILES.notes.json",
  ignoreFile: ".filesignore",
  schemaDir: "schemas",
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
      case "summarize":
        await runSummarize(parsed);
        break;
      case "watch":
        await runWatch(parsed);
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

  if (!["init", "sync", "check", "query", "summarize", "watch"].includes(commandRaw)) {
    throw new Error(`Unknown command: ${commandRaw}`);
  }

  let targetPath = ".";
  let json = false;
  let full = false;
  let force = false;
  let intervalMs = 2000;
  let maxDepth = Infinity;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--full") {
      full = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--interval") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("--interval requires a numeric value");
      }
      intervalMs = parseInterval(value);
      index += 1;
    } else if (arg.startsWith("--interval=")) {
      intervalMs = parseInterval(arg.slice("--interval=".length));
    } else if (arg === "--depth") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("--depth requires a numeric value");
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error("--depth must be a non-negative number");
      }
      maxDepth = Math.floor(parsed);
      index += 1;
    } else if (arg.startsWith("--depth=")) {
      const parsed = Number(arg.slice("--depth=".length));
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error("--depth must be a non-negative number");
      }
      maxDepth = Math.floor(parsed);
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
    full,
    force,
    intervalMs,
    maxDepth
  };
}

function parseInterval(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 250) {
    throw new Error("--interval must be a number >= 250");
  }
  return Math.floor(parsed);
}

function printHelp(): void {
  console.log(`filesense <command> [path]

Commands:
  init       Initialize .filesrc.json, .filesignore, and schema files
  sync       Recursively write FILES.json indexes
  summarize  Write heuristic FILES.notes.json summaries
  watch      Poll and sync continuously
  check      Validate coverage, freshness, and basic schema shape
  query      Read FILES.json and optional FILES.notes.json

Options:
  --full               Recompute file hashes even if mtime/size are unchanged
  --force              Overwrite inferred notes fields during summarize
  --interval <ms>      Poll interval for watch (default: 2000)
  --depth <n>          Maximum recursion depth (default: unlimited)
  --json               Print machine-readable output`);
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

  const config = await loadConfig(root);
  await ensureSchemaFiles(root, config);
  const summary = await syncIndexes(root, true, false);
  printOutput(args.json, {
    action: "init",
    root,
    configPath,
    ignorePath,
    schemaDir: path.join(root, config.schemaDir),
    summary
  }, [
    `Initialized ${root}`,
    `Config: ${configPath}`,
    `Ignore rules: ${ignorePath}`,
    `Schema dir: ${path.join(root, config.schemaDir)}`,
    formatSyncSummary(summary)
  ]);
}

async function runSync(args: ParsedArgs): Promise<void> {
  const root = path.resolve(args.targetPath);
  const summary = await syncIndexes(root, false, args.full);
  printOutput(args.json, summary, [formatSyncSummary(summary)]);
}

async function runSummarize(args: ParsedArgs): Promise<void> {
  const target = path.resolve(args.targetPath);
  await syncIndexes(target, false, false);
  const summary = await summarizeDirectories(target, args.force);
  printOutput(args.json, summary, [formatSummarizeSummary(summary)]);
}

async function runWatch(args: ParsedArgs): Promise<void> {
  const target = path.resolve(args.targetPath);
  const { root } = await resolveRootAndConfig(target);
  let stopped = false;
  let running = false;

  const stop = (): void => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const tick = async (initial: boolean): Promise<void> => {
    if (running || stopped) {
      return;
    }
    running = true;
    try {
      const syncSummary = await syncIndexes(target, false, args.full);
      const summarizeSummary = await summarizeDirectories(target, false);
      if (args.json) {
        console.log(JSON.stringify({
          event: "tick",
          timestamp: new Date().toISOString(),
          sync: syncSummary,
          summarize: summarizeSummary
        }, null, 2));
      } else if (
        initial
        || syncSummary.indexesWritten > 0
        || syncSummary.filesHashed > 0
        || summarizeSummary.notesWritten > 0
      ) {
        console.log(`[${new Date().toISOString()}] ${formatSyncSummary(syncSummary)}; ${formatSummarizeSummary(summarizeSummary)}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (args.json) {
        console.log(JSON.stringify({
          event: "error",
          timestamp: new Date().toISOString(),
          message
        }, null, 2));
      } else {
        console.error(`[${new Date().toISOString()}] watch error: ${message}`);
      }
    } finally {
      running = false;
    }
  };

  if (!args.json) {
    console.log(`Watching ${root} every ${args.intervalMs}ms`);
  }
  await tick(true);

  await new Promise<void>((resolve) => {
    const loop = async (): Promise<void> => {
      if (stopped) {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
        return;
      }
      await sleep(args.intervalMs);
      await tick(false);
      void loop();
    };
    void loop();
  });
}

async function runCheck(args: ParsedArgs): Promise<void> {
  const root = path.resolve(args.targetPath);
  const summary = await checkIndexes(root);
  const lines = [
    `Checked ${summary.checkedDirectories} directories under ${summary.root}`,
    `Missing indexes: ${summary.missingIndexes.length}`,
    `Stale indexes: ${summary.staleIndexes.length}`,
    `Invalid indexes: ${summary.invalidIndexes.length}`,
    `Invalid notes: ${summary.invalidNotes.length}`,
    `Missing schemas: ${summary.missingSchemas.length}`
  ];
  appendList(lines, "Missing", summary.missingIndexes);
  appendList(lines, "Stale", summary.staleIndexes);
  appendList(lines, "Invalid indexes", summary.invalidIndexes);
  appendList(lines, "Invalid notes", summary.invalidNotes);
  appendList(lines, "Missing schemas", summary.missingSchemas);
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
  await ensureSchemaFiles(root, config);
  const summary: SyncSummary = {
    root,
    directoriesScanned: 0,
    indexesWritten: 0,
    filesHashed: 0,
    directoriesSkipped: 0
  };

  await walkDirectories(root, root, config, ignores, async (dirPath) => {
    summary.directoriesScanned += 1;
    const result = await writeDirectoryIndex(root, dirPath, config, ignores, forceFull);
    summary.filesHashed += result.filesHashed;
    if (result.wroteIndex) {
      summary.indexesWritten += 1;
    }
  }, () => {
    summary.directoriesSkipped += 1;
  });

  if (!fromInit && summary.directoriesScanned === 0) {
    throw new Error(`No directories were indexed under ${root}`);
  }

  return summary;
}

async function summarizeDirectories(targetPath: string, force: boolean): Promise<SummarizeSummary> {
  const { root, config, ignores } = await resolveRootAndConfig(targetPath);
  await ensureSchemaFiles(root, config);
  const summary: SummarizeSummary = {
    root,
    directoriesScanned: 0,
    notesWritten: 0,
    notesSkipped: 0
  };

  await walkDirectories(root, root, config, ignores, async (dirPath) => {
    summary.directoriesScanned += 1;
    const indexPath = path.join(dirPath, config.indexFile);
    if (!(await exists(indexPath))) {
      summary.notesSkipped += 1;
      return;
    }

    const index = (await readJson(indexPath)) as IndexFile;
    const notesPath = path.join(dirPath, config.notesFile);
    const previous = (await exists(notesPath)) ? ((await readJson(notesPath)) as NotesFile) : null;
    const next = buildNotesFile(root, dirPath, config, index, previous, force);

    if (previous && stableStringify(previous) === stableStringify(next)) {
      summary.notesSkipped += 1;
      return;
    }

    await writeJson(notesPath, next);
    summary.notesWritten += 1;
  }, () => undefined);

  return summary;
}

async function checkIndexes(targetPath: string): Promise<CheckSummary> {
  const { root, config, ignores } = await resolveRootAndConfig(targetPath);
  const summary: CheckSummary = {
    root,
    checkedDirectories: 0,
    missingIndexes: [],
    staleIndexes: [],
    invalidIndexes: [],
    invalidNotes: [],
    missingSchemas: []
  };

  const schemaPaths = schemaPathsForRoot(root, config);
  for (const schemaPath of [schemaPaths.indexSchemaPath, schemaPaths.notesSchemaPath]) {
    if (!(await exists(schemaPath))) {
      summary.missingSchemas.push(relativeDisplay(root, schemaPath));
      continue;
    }
    try {
      await readJson(schemaPath);
    } catch {
      summary.missingSchemas.push(relativeDisplay(root, schemaPath));
    }
  }

  await walkDirectories(root, root, config, ignores, async (dirPath) => {
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

    if (!isValidIndexFile(index, root, dirPath, config)) {
      summary.invalidIndexes.push(relativeDisplay(root, indexPath));
      return;
    }

    const notesPath = path.join(dirPath, config.notesFile);
    if (await exists(notesPath)) {
      try {
        const notes = (await readJson(notesPath)) as NotesFile;
        if (!isValidNotesFile(notes, root, dirPath, config)) {
          summary.invalidNotes.push(relativeDisplay(root, notesPath));
        }
      } catch {
        summary.invalidNotes.push(relativeDisplay(root, notesPath));
      }
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

async function writeDirectoryIndex(root: string, dirPath: string, config: Config, ignores: IgnoreMatcher, forceFull: boolean): Promise<WriteIndexResult> {
  const indexPath = path.join(dirPath, config.indexFile);
  const previous = (await exists(indexPath)) ? ((await readJson(indexPath)) as IndexFile) : null;
  const previousMap = new Map(previous?.children.map((child) => [child.name, child]) ?? []);
  const entries = await listTrackedEntries(root, dirPath, config, ignores);
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
  const relativePath = relativeToRoot(root, dirPath);
  const nextSchema = relativeSchemaRef(dirPath, schemaPathsForRoot(root, config).indexSchemaPath);
  const previousComparable = previous ? comparableIndex(previous) : null;
  const nextComparable = {
    $schema: nextSchema,
    schema_version: config.schemaVersion,
    root_relative_path: relativePath,
    directory: {
      name: path.basename(dirPath),
      path: relativePath
    },
    children,
    sync: {
      child_count: children.length,
      file_count: children.filter((item) => item.type === "file").length,
      dir_count: children.filter((item) => item.type === "dir").length
    }
  };

  if (previousComparable && stableStringify(previousComparable) === stableStringify(nextComparable)) {
    return { filesHashed, wroteIndex: false };
  }

  const timestamp = new Date().toISOString();
  const nextIndex: IndexFile = {
    $schema: nextSchema,
    schema_version: config.schemaVersion,
    generated_at: timestamp,
    root_relative_path: relativePath,
    directory: {
      name: path.basename(dirPath),
      path: relativePath
    },
    children,
    sync: {
      child_count: nextComparable.sync.child_count,
      file_count: nextComparable.sync.file_count,
      dir_count: nextComparable.sync.dir_count,
      last_full_sync: forceFull ? timestamp : previous?.sync.last_full_sync ?? null,
      last_incremental_sync: timestamp
    }
  };

  await writeJson(indexPath, nextIndex);
  return { filesHashed, wroteIndex: true };
}

function comparableIndex(index: IndexFile): ComparableIndex {
  return {
    $schema: index.$schema,
    schema_version: index.schema_version,
    root_relative_path: index.root_relative_path,
    directory: index.directory,
    children: index.children,
    sync: {
      child_count: index.sync.child_count,
      file_count: index.sync.file_count,
      dir_count: index.sync.dir_count
    }
  };
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
    if (relative === config.schemaDir || relative.startsWith(config.schemaDir + "/")) {
      continue;
    }
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
  config: Config,
  ignores: IgnoreMatcher,
  onDirectory: (dirPath: string) => Promise<void>,
  onSkip: () => void
): Promise<void> {
  await onDirectory(startDir);

  if (!config.recursive) {
    return;
  }

  const items = await fs.readdir(startDir, { withFileTypes: true });
  for (const item of items) {
    if (!item.isDirectory()) {
      continue;
    }
    const absolutePath = path.join(startDir, item.name);
    const relative = relativeToRoot(root, absolutePath);
    if (relative === config.schemaDir || relative.startsWith(config.schemaDir + "/")) {
      onSkip();
      continue;
    }
    if (ignores(relative, true)) {
      onSkip();
      continue;
    }
    await walkDirectories(root, absolutePath, config, ignores, onDirectory, onSkip);
  }
}

type IgnoreMatcher = (relativePath: string, isDirectory: boolean) => boolean;

async function resolveRootAndConfig(targetPath: string): Promise<{ root: string; config: Config; ignores: IgnoreMatcher }> {
  const root = await findConfigRoot(targetPath);
  const config = await loadConfig(root);
  const ignores = await loadIgnoreMatcher(root, config);
  return { root, config, ignores };
}

async function loadConfig(root: string): Promise<Config> {
  const configPath = path.join(root, ".filesrc.json");
  if (!(await exists(configPath))) {
    return DEFAULT_CONFIG;
  }

  const parsed = await readJson(configPath);
  const userConfig = validateConfig(parsed, configPath);
  return { ...DEFAULT_CONFIG, ...userConfig } satisfies Config;
}

function validateConfig(value: unknown, configPath: string): Partial<Config> {
  if (!isRecord(value)) {
    throw new Error(`${configPath} must contain a JSON object`);
  }

  const config: Partial<Config> = {};
  validateOptionalString(value, config, "schemaVersion", configPath);
  validateOptionalString(value, config, "root", configPath);
  validateOptionalString(value, config, "indexFile", configPath);
  validateOptionalString(value, config, "notesFile", configPath);
  validateOptionalString(value, config, "ignoreFile", configPath);
  validateOptionalString(value, config, "schemaDir", configPath);

  if ("recursive" in value) {
    if (typeof value.recursive !== "boolean") {
      throw new Error(`${configPath}: recursive must be a boolean`);
    }
    config.recursive = value.recursive;
  }

  if ("exclude" in value) {
    if (!Array.isArray(value.exclude) || !value.exclude.every((item) => typeof item === "string")) {
      throw new Error(`${configPath}: exclude must be an array of strings`);
    }
    config.exclude = value.exclude;
  }

  if ("hashAlgorithm" in value) {
    if (value.hashAlgorithm !== "sha1") {
      throw new Error(`${configPath}: hashAlgorithm must be "sha1"`);
    }
    config.hashAlgorithm = value.hashAlgorithm;
  }

  return config;
}

function validateOptionalString<T extends keyof Pick<Config, "schemaVersion" | "root" | "indexFile" | "notesFile" | "ignoreFile" | "schemaDir">>(
  value: Record<string, unknown>,
  config: Partial<Config>,
  key: T,
  configPath: string
): void {
  if (!(key in value)) {
    return;
  }
  if (typeof value[key] !== "string" || value[key].length === 0) {
    throw new Error(`${configPath}: ${key} must be a non-empty string`);
  }
  config[key] = value[key];
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
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function hashFile(targetPath: string, algorithm: "sha1"): Promise<string> {
  const hash = createHash(algorithm);
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(targetPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return `${algorithm}:${hash.digest("hex")}`;
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
  if (ext === ".vue") {
    return "Vue single-file component";
  }
  if (ext === ".svelte") {
    return "Svelte component";
  }
  if (ext === ".css" || ext === ".scss" || ext === ".less" || ext === ".sass") {
    return "Stylesheet";
  }
  if (ext === ".html") {
    return "HTML document";
  }
  if (ext === ".svg") {
    return "SVG image";
  }
  if (!ext) {
    return "File without extension";
  }
  return `${ext.slice(1).toUpperCase()} file`;
}

function inferImportance(name: string): "high" | "normal" {
  if (/^(readme|package|tsconfig|index|main|app)\./i.test(name)) {
    return "high";
  }
  if (/\.(config|rc)\./i.test(name)) {
    return "high";
  }
  if (/^(vite|webpack|rollup|next|nuxt|tailwind|postcss|babel|jest|vitest)\.config\./i.test(name)) {
    return "high";
  }
  return "normal";
}

function buildNotesFile(root: string, dirPath: string, config: Config, index: IndexFile, previous: NotesFile | null, force: boolean): NotesFile {
  const inferred: NotesFile = {
    $schema: relativeSchemaRef(dirPath, schemaPathsForRoot(root, config).notesSchemaPath),
    directory_purpose: inferDirectoryPurpose(index),
    agent_hints: inferAgentHints(index),
    conventions: inferConventions(index),
    key_entrypoints: inferKeyEntrypoints(index)
  };

  if (!previous || force) {
    return inferred;
  }

  return {
    $schema: inferred.$schema,
    directory_purpose: previous.directory_purpose || inferred.directory_purpose,
    agent_hints: previous.agent_hints?.length ? previous.agent_hints : inferred.agent_hints,
    conventions: previous.conventions?.length ? previous.conventions : inferred.conventions,
    key_entrypoints: previous.key_entrypoints?.length ? previous.key_entrypoints : inferred.key_entrypoints
  };
}

function inferDirectoryPurpose(index: IndexFile): string {
  const dirName = index.directory.name.toLowerCase();
  if (index.directory.path === ".") {
    return "Project root directory containing source code, configuration, and supporting files.";
  }
  if (dirName === "src") {
    return "Primary application source directory.";
  }
  if (dirName === "docs") {
    return "Documentation directory for project guides and reference material.";
  }
  if (dirName === "test" || dirName === "tests" || dirName === "__tests__") {
    return "Automated test directory.";
  }
  if (dirName === "scripts") {
    return "Automation scripts directory.";
  }
  if (dirName === "components") {
    return "Reusable component directory.";
  }
  if (dirName === "lib") {
    return "Shared library code directory.";
  }
  if (dirName === "api" || dirName === "services") {
    return "API/service layer directory.";
  }
  if (dirName === "hooks") {
    return "Custom React hooks directory.";
  }
  if (dirName === "utils" || dirName === "helpers") {
    return "Utility functions directory.";
  }
  if (dirName === "pages" || dirName === "views") {
    return "Page/view components directory.";
  }
  if (dirName === "store" || dirName === "stores") {
    return "State management directory.";
  }
  if (dirName === "styles" || dirName === "css") {
    return "Stylesheets directory.";
  }
  if (dirName === "assets" || dirName === "public" || dirName === "static") {
    return "Static assets directory.";
  }
  if (dirName === "types" || dirName === "typings") {
    return "TypeScript type definitions directory.";
  }
  if (dirName === "layouts") {
    return "Layout components directory.";
  }
  if (dirName === "middleware" || dirName === "middlewares") {
    return "Middleware functions directory.";
  }
  if (dirName === "config" || dirName === "configs") {
    return "Configuration files directory.";
  }
  if (dirName === "constants") {
    return "Constants and enums directory.";
  }
  if (dirName === "models") {
    return "Data models directory.";
  }
  if (dirName === "plugins") {
    return "Plugin extensions directory.";
  }
  if (dirName === "i18n" || dirName === "locales" || dirName === "locale") {
    return "Internationalization/localization directory.";
  }

  const fileCount = index.children.filter((child) => child.type === "file").length;
  const dirCount = index.children.filter((child) => child.type === "dir").length;
  if (fileCount === 0 && dirCount > 0) {
    return "Grouping directory for related subdirectories.";
  }
  if (hasExtensions(index, [".ts", ".tsx", ".js", ".jsx"])) {
    return "Source directory for related implementation files.";
  }
  if (hasExtensions(index, [".md"])) {
    return "Documentation-focused directory.";
  }
  return "Directory for related project files.";
}

function inferAgentHints(index: IndexFile): string[] {
  const hints: string[] = [];
  const names = new Set(index.children.map((child) => child.name));
  const entrypoints = inferKeyEntrypoints(index);
  if (entrypoints.length > 0) {
    hints.push(`Read ${entrypoints.slice(0, 3).join(", ")} first for local entrypoints and conventions.`);
  }
  if (names.has("package.json")) {
    hints.push("Inspect package.json before changing scripts, package metadata, or dependencies.");
  }
  if (names.has("tsconfig.json")) {
    hints.push("Respect tsconfig.json compiler settings when adding or moving TypeScript files.");
  }
  if (index.children.some((child) => child.type === "dir") && index.children.filter((child) => child.type === "file").length <= 2) {
    hints.push("Descend into child directories before making edits here; this level is mostly structural.");
  }
  if (hints.length === 0) {
    hints.push("Start from high-importance files before editing lower-level implementation details.");
  }
  return hints.slice(0, 4);
}

function inferConventions(index: IndexFile): string[] {
  const conventions: string[] = [];
  if (hasExtensions(index, [".ts", ".tsx"])) {
    conventions.push("Prefer TypeScript for new source files in this directory.");
  }
  if (index.children.some((child) => child.ext === ".tsx" && /^[A-Z]/.test(child.name))) {
    conventions.push("Component-like files use PascalCase filenames.");
  }
  if (index.children.some((child) => /test|spec/i.test(child.name))) {
    conventions.push("Keep tests close to the implementation they validate.");
  }
  if (index.children.some((child) => child.name === "README.md")) {
    conventions.push("Update README.md when directory-level usage or setup changes.");
  }
  if (conventions.length === 0) {
    conventions.push("Preserve the local naming and file-placement patterns already present here.");
  }
  return conventions.slice(0, 4);
}

function inferKeyEntrypoints(index: IndexFile): string[] {
  const preferred = ["README.md", "package.json", "tsconfig.json", "index.ts", "index.tsx", "main.ts", "main.js"];
  const names = index.children.map((child) => child.name);
  const selected = preferred.filter((name) => names.includes(name));
  if (selected.length > 0) {
    return selected.slice(0, 6);
  }
  return index.children
    .filter((child) => child.type === "file" && child.importance === "high")
    .map((child) => child.name)
    .slice(0, 6);
}

function hasExtensions(index: IndexFile, exts: string[]): boolean {
  return index.children.some((child) => exts.includes(child.ext));
}

function schemaPathsForRoot(root: string, config: Config): SchemaPaths {
  return {
    indexSchemaPath: path.join(root, config.schemaDir, "FILES.schema.json"),
    notesSchemaPath: path.join(root, config.schemaDir, "FILES.notes.schema.json")
  };
}

async function ensureSchemaFiles(root: string, config: Config): Promise<void> {
  const paths = schemaPathsForRoot(root, config);
  const indexSchema = buildIndexSchema(config);
  const notesSchema = buildNotesSchema(config);
  if (!(await exists(paths.indexSchemaPath)) || stableStringify(await readJsonSafe(paths.indexSchemaPath)) !== stableStringify(indexSchema)) {
    await writeJson(paths.indexSchemaPath, indexSchema);
  }
  if (!(await exists(paths.notesSchemaPath)) || stableStringify(await readJsonSafe(paths.notesSchemaPath)) !== stableStringify(notesSchema)) {
    await writeJson(paths.notesSchemaPath, notesSchema);
  }
}

async function readJsonSafe(targetPath: string): Promise<unknown | null> {
  try {
    return await readJson(targetPath);
  } catch {
    return null;
  }
}

function buildIndexSchema(config: Config): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://filesense.dev/schema/${config.schemaVersion}/FILES.schema.json`,
    title: "FILES.json",
    type: "object",
    required: ["schema_version", "generated_at", "root_relative_path", "directory", "children", "sync"],
    additionalProperties: false,
    properties: {
      $schema: { type: "string" },
      schema_version: { type: "string" },
      generated_at: { type: "string" },
      root_relative_path: { type: "string" },
      directory: {
        type: "object",
        required: ["name", "path"],
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          path: { type: "string" }
        }
      },
      children: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "type", "path", "ext", "size", "mtimeMs", "hash", "summary", "importance", "status"],
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            type: { enum: ["file", "dir"] },
            path: { type: "string" },
            ext: { type: "string" },
            size: { type: "number" },
            mtimeMs: { type: "number" },
            hash: { anyOf: [{ type: "string" }, { type: "null" }] },
            summary: { type: "string" },
            importance: { enum: ["high", "normal"] },
            status: { enum: ["active"] }
          }
        }
      },
      sync: {
        type: "object",
        required: ["child_count", "file_count", "dir_count", "last_full_sync", "last_incremental_sync"],
        additionalProperties: false,
        properties: {
          child_count: { type: "number" },
          file_count: { type: "number" },
          dir_count: { type: "number" },
          last_full_sync: { anyOf: [{ type: "string" }, { type: "null" }] },
          last_incremental_sync: { anyOf: [{ type: "string" }, { type: "null" }] }
        }
      }
    }
  };
}

function buildNotesSchema(config: Config): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://filesense.dev/schema/${config.schemaVersion}/FILES.notes.schema.json`,
    title: "FILES.notes.json",
    type: "object",
    additionalProperties: false,
    properties: {
      $schema: { type: "string" },
      directory_purpose: { type: "string" },
      agent_hints: { type: "array", items: { type: "string" } },
      conventions: { type: "array", items: { type: "string" } },
      key_entrypoints: { type: "array", items: { type: "string" } }
    }
  };
}

function relativeSchemaRef(dirPath: string, schemaPath: string): string {
  return path.relative(dirPath, schemaPath).replace(/\\/g, "/");
}

function isValidIndexFile(value: unknown, root: string, dirPath: string, config: Config): value is IndexFile {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.schema_version !== "string" || typeof value.generated_at !== "string" || typeof value.root_relative_path !== "string") {
    return false;
  }
  if (value.$schema !== undefined && value.$schema !== relativeSchemaRef(dirPath, schemaPathsForRoot(root, config).indexSchemaPath)) {
    return false;
  }
  if (!isRecord(value.directory) || typeof value.directory.name !== "string" || typeof value.directory.path !== "string") {
    return false;
  }
  if (!Array.isArray(value.children) || !isRecord(value.sync)) {
    return false;
  }
  if (
    typeof value.sync.child_count !== "number"
    || typeof value.sync.file_count !== "number"
    || typeof value.sync.dir_count !== "number"
    || !isNullableString(value.sync.last_full_sync)
    || !isNullableString(value.sync.last_incremental_sync)
  ) {
    return false;
  }
  for (const child of value.children) {
    if (!isRecord(child)) {
      return false;
    }
    if (
      typeof child.name !== "string"
      || (child.type !== "file" && child.type !== "dir")
      || typeof child.path !== "string"
      || typeof child.ext !== "string"
      || typeof child.size !== "number"
      || typeof child.mtimeMs !== "number"
      || !isNullableString(child.hash)
      || typeof child.summary !== "string"
      || (child.importance !== "high" && child.importance !== "normal")
      || child.status !== "active"
    ) {
      return false;
    }
  }
  return true;
}

function isValidNotesFile(value: unknown, root: string, dirPath: string, config: Config): value is NotesFile {
  if (!isRecord(value)) {
    return false;
  }
  if (value.$schema !== undefined && value.$schema !== relativeSchemaRef(dirPath, schemaPathsForRoot(root, config).notesSchemaPath)) {
    return false;
  }
  if (value.directory_purpose !== undefined && typeof value.directory_purpose !== "string") {
    return false;
  }
  if (!isOptionalStringArray(value.agent_hints) || !isOptionalStringArray(value.conventions) || !isOptionalStringArray(value.key_entrypoints)) {
    return false;
  }
  return true;
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatSyncSummary(summary: SyncSummary): string {
  return `Synced ${summary.directoriesScanned} directories, wrote ${summary.indexesWritten} indexes, hashed ${summary.filesHashed} files, skipped ${summary.directoriesSkipped} directories`;
}

function formatSummarizeSummary(summary: SummarizeSummary): string {
  return `Summarized ${summary.directoriesScanned} directories, wrote ${summary.notesWritten} notes files, skipped ${summary.notesSkipped}`;
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

function appendList(lines: string[], title: string, values: string[]): void {
  if (values.length === 0) {
    return;
  }
  lines.push(`${title}:`);
  lines.push(...values.map((value) => `  ${value}`));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!isRecord(value)) {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = sortKeys(value[key]);
  }
  return output;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

void main();
