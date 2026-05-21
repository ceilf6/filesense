# filesense

Agent-friendly directory indexing CLI. Filesense writes small `FILES.json` indexes next to project directories so agents and tools can quickly understand what exists, what changed, and where to look next.

## Install

```sh
npm install
npm run build
npm link
```

Or run directly from this repository after building:

```sh
node dist/index.js --help
```

## Quickstart

```sh
filesense init .
filesense sync . --json
filesense summarize .
filesense check .
filesense query .
```

`init` creates `.filesrc.json`, `.filesignore`, root schemas, and an initial `FILES.json` index.

## Commands

- `filesense init [path]` — initialize config, ignore rules, schemas, and indexes
- `filesense sync [path] [--full] [--depth <n>] [--json]` — write or refresh `FILES.json`
- `filesense summarize [path] [--force] [--depth <n>] [--json]` — write heuristic `FILES.notes.json`
- `filesense watch [path] [--interval 2000] [--full] [--depth <n>] [--json]` — poll and run sync plus summarize
- `filesense check [path] [--depth <n>] [--json]` — validate index coverage, freshness, and schema shape
- `filesense query [path] [--json]` — read one directory index and optional notes

## Options

- `--full` — recompute file hashes even if mtime and size are unchanged
- `--force` — overwrite inferred notes fields during summarize
- `--interval <ms>` — poll interval for watch; minimum 250, default 2000
- `--depth <n>` — maximum recursion depth; default is unlimited
- `--json` — print machine-readable output

## Model

- Each indexed directory gets a machine-maintained `FILES.json`.
- Optional human or agent semantic notes live in `FILES.notes.json`.
- Root-level schemas live in `schemas/FILES.schema.json` and `schemas/FILES.notes.schema.json`.
- `sync` updates machine-managed fields and preserves notes files.
- `summarize` fills `FILES.notes.json` with heuristic directory purpose, hints, conventions, and entrypoints.
- `watch` polls and runs incremental `sync + summarize` without rewriting unchanged indexes.

## Configuration

Filesense reads `.filesrc.json` from the target directory or the nearest parent directory.

```json
{
  "schemaVersion": "1.0",
  "root": ".",
  "recursive": true,
  "indexFile": "FILES.json",
  "notesFile": "FILES.notes.json",
  "ignoreFile": ".filesignore",
  "schemaDir": "schemas",
  "exclude": [".git", "node_modules", "dist", "build", ".next", "coverage"],
  "hashAlgorithm": "sha1"
}
```

Partial configs are allowed and merge with defaults. Invalid config values fail fast with an actionable error.

## Ignore rules

Ignore rules come from the `exclude` array plus `.filesignore` lines. Empty lines and comments beginning with `#` are ignored.

Examples:

```gitignore
node_modules
coverage/
.env
packages/generated/
*.log
!important.log
```

- A plain name ignores matching path parts.
- A trailing slash ignores that directory and its contents.
- A path with `/` ignores that relative path and descendants.
- Glob patterns with `*` match file names (e.g., `*.log`, `build-*`).
- `**` matches across directory boundaries (e.g., `src/**/test`).
- A `!` prefix negates a previous rule, re-including the matched file.

## JSON output

Use `--json` when integrating with scripts or agents.

```sh
filesense check . --json
```

Example shape:

```json
{
  "root": "/repo",
  "checkedDirectories": 3,
  "missingIndexes": [],
  "staleIndexes": [],
  "invalidIndexes": [],
  "invalidNotes": [],
  "missingSchemas": []
}
```

## Common workflows

Refresh all indexes after changing files:

```sh
filesense sync .
```

Recompute hashes even when metadata looks unchanged:

```sh
filesense sync . --full
```

Generate agent notes after syncing:

```sh
filesense summarize .
```

Continuously refresh indexes during active editing:

```sh
filesense watch . --interval 2000
```

## Troubleshooting

- `No FILES.json found`: run `filesense sync <path>` or `filesense init <path>` first.
- `Not a directory`: pass an existing directory path.
- Invalid `.filesrc.json`: check field types and keep `hashAlgorithm` as `sha1`.
- Stale indexes from `check`: run `filesense sync <path>` to refresh metadata and hashes.

## Integration with FrontAgent

Filesense is integrated into FrontAgent as `@frontagent/mcp-filesense`, providing:

- MCP tools (`filesense_init`, `filesense_sync`, `filesense_summarize`, `filesense_query`, `filesense_check`, `filesense_sync_and_summarize`)
- Automatic directory indexing before file-heavy tasks via planner phase injection
- ProjectFacts enrichment from index data (file/directory existence)
- Filesense context injection into the system prompt for enhanced directory awareness

## Frontend-aware inference

Filesense recognizes common frontend project patterns:

- Directory purposes: components, hooks, pages, views, store, styles, assets, layouts, middleware, i18n, types, constants, models, plugins
- File importance: config files such as Vite, webpack, Next, Tailwind, and entry points like `index`, `main`, and `App`
- File types: Vue SFC, Svelte components, stylesheets, and SVG
