import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type CommandName = "init" | "sync" | "check" | "query" | "summarize" | "watch";

export type ParsedArgs = {
  command: CommandName;
  targetPath: string;
  json: boolean;
  full: boolean;
  force: boolean;
  intervalMs: number;
  maxDepth: number;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const [commandRaw, ...rest] = argv;
  if (!commandRaw || commandRaw === "--help" || commandRaw === "-h") {
    printHelp();
    process.exit(0);
  }

  if (commandRaw === "--version" || commandRaw === "-v") {
    printVersion();
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

function printVersion(): void {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(thisDir, "..", "package.json");
  const { version } = JSON.parse(readFileSync(pkgPath, "utf8"));
  console.log(version);
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
