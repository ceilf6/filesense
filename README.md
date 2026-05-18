# filesense

Agent-friendly directory indexing CLI.

## Commands

- `filesense init [path]`
- `filesense sync [path] [--full] [--json]`
- `filesense summarize [path] [--force] [--json]`
- `filesense watch [path] [--interval 2000] [--full] [--json]`
- `filesense check [path] [--json]`
- `filesense query [path] [--json]`

## Model

- Each directory gets a machine-maintained `FILES.json`
- Optional human/agent semantic notes live in `FILES.notes.json`
- Root-level schemas live in `schemas/FILES.schema.json` and `schemas/FILES.notes.schema.json`
- `sync` updates only machine-managed fields and preserves notes files
- `summarize` fills `FILES.notes.json` with heuristic directory purpose, hints, conventions, and entrypoints
- `watch` polls and runs incremental `sync + summarize` without rewriting unchanged indexes
