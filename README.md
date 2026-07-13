# repo-intelligence-layer

**repo-intelligence-layer is not just another dependency graph.** It builds a semantic knowledge layer over a codebase so autonomous coding agents (Claude Code, Gemini CLI, and similar) can answer architectural questions without repeatedly reading thousands of lines of source. Instead of consuming raw files, agents query compact semantic metadata — dramatically reducing context usage while preserving architectural understanding.

Mechanically: it's an autonomous code-analysis agent for TypeScript/React(-Native) codebases. It watches a repository for changes, analyzes each `.ts`/`.tsx` file with a local LLM (via [Ollama](https://ollama.com)) plus a TypeScript AST parser, and builds a searchable **knowledge graph** of the codebase — files, exports, components, hooks, dependencies, and routes — exposed through a live web dashboard and a CLI query tool.

## Designed for Autonomous Agents

Unlike traditional static-analysis tools built for human readers, this project is designed around autonomous coding agents that need to act on a codebase without reading all of it first.

Instead of asking an LLM to inspect hundreds of files to understand a feature, agents query the knowledge graph first, decide what's actually relevant from the identity cards (see below), and only then open the two or three files that matter.

**Example** — "Add a cache layer to question management":

| | |
|---|---|
| **Traditional workflow** | read `question.ts` → read `question-manager.ts` → read `question-service.ts` → read `database.ts` → read a dozen more related files just to build a mental model |
| **repo-intelligence-layer workflow** | `query("question")` → inspect the identity cards of the matches → determine the 2 relevant modules → read only those |

The knowledge graph is treated as the primary interface, while the source code becomes a secondary data source, read only when the graph says it's necessary.

## Identity Cards

Instead of exposing raw source files to an LLM, every analyzed file gets a compact semantic identity — printed via `node scripts/depencies.js file <path>` and stored in `knowledge_graph.json`:

- Category & Role (e.g. `CRUD Service`, screen, hook)
- Framework
- Purpose (one-sentence LLM summary, from the JSON sidecar)
- Risk & Importance (deterministic, based on dependents/exports/calls)
- Dependents & Stability (commits since the file was last touched)
- Objective AST metrics (exports, functions, hooks, components, entities)

This lets an agent decide whether a file is worth reading at all before spending context on it.

## What it does

- **Continuous scanning** — polls the target directory every 5s, hashes each source file, and re-analyzes only new/changed files (`analysis.tsx`).
- **AST-based objective facts** — uses the TypeScript compiler API to deterministically extract line count, imports/exports, functions, hooks, components, JSX renders, and call expressions (no LLM guessing involved).
- **LLM sidecar generation** — for each file, calls a local Ollama model to produce:
  - A full Markdown architecture-review report (`ai-reports/<file>.md`).
  - A one-sentence `purpose` summary, schema-constrained JSON (`ai-reports/<file>.json`).
  - An on-demand two-sentence "deep summary" of the file's architectural role, generated lazily from the dashboard and cached back into the sidecar.
- **Knowledge graph** — merges all sidecars into `ai-reports/knowledge_graph.json`, resolving local imports (`./`, `@/`) into a dependency graph and computing `importedBy` / `importance` per file.
- **Expo Router awareness** — infers screen routes from file paths under `src/app/` (dynamic segments, layouts, `index` routes).
- **Deterministic risk scoring** — `dependents×3 + exports×2 + calls + lines/100`, tiered Low/Medium/High/Critical, shown per node in the graph view.
- **Live dashboard** (`http://localhost:5959`) — real-time event stream (SSE), current file being analyzed with streaming LLM output, full-text search across the knowledge graph, completed-report viewer, and an interactive force-directed dependency graph (drag nodes, filter by category, per-node risk breakdown, click-to-generate deep AI summary).
- **CLI query tool** (`scripts/depencies.js`) — inspects `knowledge_graph.json` without dumping raw JSON into an LLM's context window.

## How it works

```
source files (*.ts/*.tsx)
        │
        ▼
  watchLoop() ── hash diff vs .state.json
        │
        ▼
  analyzeFile()
    ├─ TypeScript AST  → objective facts + entities + calls + renders
    ├─ Ollama (stream) → full Markdown report        → ai-reports/<file>.md
    └─ Ollama (JSON)   → one-line purpose             → ai-reports/<file>.json
        │
        ▼
  rebuildKnowledgeGraph() → ai-reports/knowledge_graph.json
        │
        ▼
  dashboard (Bun.serve, port 5959) ── SSE /events, /graph, /report, /explain
```

## Requirements

- [Bun](https://bun.sh) — the agent (`analysis.tsx`) uses `Bun.serve` and `Bun.file` and must be run with the Bun runtime.
- [Node.js](https://nodejs.org) — used to run the CLI query tool (`scripts/depencies.js`).
- [Ollama](https://ollama.com) running locally at `http://localhost:11434` with:
  - A chat/generation model matching `MODEL` in `analysis.tsx` (defaults to `gemma4:26b` — change this to a model you actually have pulled).
  - Optionally an embeddings model (defaults to `nomic-embed-text`, override via `OLLAMA_EMBED_MODEL`) for `scripts/depencies.js similar`; without it, similarity falls back to bag-of-words comparison.
- The `typescript` package (used via `import * as ts from "typescript"` for AST parsing). There is no `package.json` in this repo yet — install `typescript` in your project before running the agent, e.g. `bun add typescript` (or `bun add -d typescript`).

## Usage

### Run the agent

```bash
bun run analysis.tsx
```

This starts the continuous file-watch loop and the dashboard server at `http://localhost:5959` in the same process. Reports and the knowledge graph are written under `ai-reports/` in the current working directory (this directory is skipped by the scanner itself, along with `node_modules`, `.next`, `.git`, `.expo`).

### Query the knowledge graph

```bash
node scripts/depencies.js <command> <arg>
```

| Command | Description |
|---|---|
| `query <term>` | Search file paths, purposes, and entity names by substring |
| `file <path>` | Print a full "identity card" for a file (category, role, framework, size, stability, risk) |
| `dependents <path>` | List files that import `<path>` |
| `deps <path>` | List files/packages `<path>` imports |
| `callers <fnName>` | List files whose AST call list references `<fnName>` |
| `where <Component>` | Which files render `<Component>` in JSX |
| `style <Component>` | Most-used `name` prop values on `<Component>` (e.g. icon sets) |
| `impact <path>` | Transitive dependents of `<path>` plus a LOW/MEDIUM/HIGH risk level |
| `change <path>` | Which screens (routes) are affected if `<path>` changes |
| `similar <path>` | Most similar files, via Ollama embeddings if available, else word-based fallback |

Paths are matched exactly as stored in `knowledge_graph.json` (e.g. `src/app/quiz.tsx`). Each command prints a freshness banner warning if source files have changed since the graph was last generated.

## Output layout

```
ai-reports/
  .state.json               file hash → last-analyzed metadata (used to detect changes)
  .status.json              latest dashboard status snapshot (debug/persistence)
  knowledge_graph.json       merged graph of all analyzed files
  embeddings_cache.json      cached Ollama embeddings for `similar`
  <mirrored source path>.md   per-file Markdown architecture report
  <mirrored source path>.json per-file sidecar (objective facts, purpose, graph, entities)
```

## Notes

- The dashboard UI and the LLM prompts in `analysis.tsx` are written in Turkish (`lang="tr"`, prompts explicitly request Turkish output); this README documents the tool in English.
- `scripts/depencies.js` is the actual filename in this repo (note the missing "d" — it's a typo for "dependencies.js"); invoke it as shown above.
- The categorization logic in the dashboard's dependency graph (`categoryOf`) and in `scripts/depencies.js` (`categorizeNode`) assumes a `src/app`, `src/components`, `src/hooks`, `src/services`, `src/theme`, `src/i18n` layout — adjust these if analyzing a repo with a different structure.

## Roadmap

- [x] AST extraction
- [x] Semantic purpose generation
- [x] Dependency graph
- [x] Identity cards
- [x] Impact analysis
- [ ] Incremental AI change summaries
- [ ] Semantic evolution history
- [ ] Cross-repository knowledge graphs
- [ ] MCP server
