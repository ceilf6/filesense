# files-agent-cli

Agent-friendly directory indexing CLI.

## Commands

- `files-agent init [path]`
- `files-agent sync [path] [--full] [--json]`
- `files-agent check [path] [--json]`
- `files-agent query [path] [--json]`

## Model

- Each directory gets a machine-maintained `FILES.json`
- Optional human/agent semantic notes live in `FILES.notes.json`
- `sync` updates only machine-managed fields and preserves notes files
