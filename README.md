# filesense

Agent-friendly directory indexing CLI.

## Commands

- `filesense init [path]`
- `filesense sync [path] [--full] [--json]`
- `filesense check [path] [--json]`
- `filesense query [path] [--json]`

## Model

- Each directory gets a machine-maintained `FILES.json`
- Optional human/agent semantic notes live in `FILES.notes.json`
- `sync` updates only machine-managed fields and preserves notes files
