# filesense

Agent-friendly directory indexing CLI.

## Commands

- `filesense init [path]`
- `filesense sync [path] [--full] [--depth <n>] [--json]`
- `filesense summarize [path] [--force] [--depth <n>] [--json]`
- `filesense watch [path] [--interval 2000] [--full] [--depth <n>] [--json]`
- `filesense check [path] [--depth <n>] [--json]`
- `filesense query [path] [--json]`

## Options

- `--full` — Recompute file hashes even if mtime/size are unchanged
- `--force` — Overwrite inferred notes fields during summarize
- `--interval <ms>` — Poll interval for watch (default: 2000)
- `--depth <n>` — Maximum recursion depth (default: unlimited)
- `--json` — Print machine-readable output

## Model

- Each directory gets a machine-maintained `FILES.json`
- Optional human/agent semantic notes live in `FILES.notes.json`
- Root-level schemas live in `schemas/FILES.schema.json` and `schemas/FILES.notes.schema.json`
- `sync` updates only machine-managed fields and preserves notes files
- `summarize` fills `FILES.notes.json` with heuristic directory purpose, hints, conventions, and entrypoints
- `watch` polls and runs incremental `sync + summarize` without rewriting unchanged indexes

## Integration with FrontAgent

Filesense is integrated into FrontAgent as `@frontagent/mcp-filesense`, providing:

- MCP tools (`filesense_init`, `filesense_sync`, `filesense_summarize`, `filesense_query`, `filesense_check`, `filesense_sync_and_summarize`)
- Automatic directory indexing before file-heavy tasks via planner phase injection
- ProjectFacts enrichment from index data (file/directory existence)
- Filesense context injection into the system prompt for enhanced directory awareness

## Frontend-Aware Inference

Filesense recognizes common frontend project patterns:

- **Directory purposes**: components, hooks, pages, views, store, styles, assets, layouts, middleware, i18n, types, constants, models, plugins
- **File importance**: config files (vite, webpack, next, tailwind, etc.), entry points (index, main, App)
- **File types**: Vue SFC, Svelte components, stylesheets (CSS/SCSS/Less/Sass), SVG
