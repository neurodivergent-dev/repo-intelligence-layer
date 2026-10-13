# repo-intelligence-layer

**repo-intelligence-layer is not just another dependency graph.** It builds a semantic knowledge & closed-loop verification layer over a TypeScript / React(-Native) codebase so autonomous coding agents (Claude Code, Gemini CLI, Cursor, and similar) can navigate, reason, and act with architectural certainty without repeatedly burning tens of thousands of tokens reading raw source files.

Instead of consuming raw files, agents query compact semantic metadata and execute deterministic guardrails — dramatically reducing context usage while preserving architectural integrity.

---

## Architecture & Subsystems

The intelligence layer is split into continuous knowledge extraction, on-demand domain navigators, and a 6-gate safety validation chain:

```
                          source files (*.ts / *.tsx)
                                      │
                                      ▼
                        analysis.tsx (Bun Watcher)
                                      ├─ TypeScript AST parser
                                      └─ Local Ollama sidecar (JSON / Markdown)
                                      │
                                      ▼
                         knowledge_graph.json + sidecars
                                      │
   ┌──────────────────────────────────┼──────────────────────────────────┐
   ▼                                  ▼                                  ▼
[DOMAIN NAVIGATORS]             [KNOWLEDGE GRAPH]               [CLOSED-LOOP GUARDRAIL]
• route-navigator.js            • depencies.js                  • blast-radius.js (6 gates)
• supabase-mapper.js              (query, file, deps, callers)    ├─ 1. TypeScript compiler
• i18n-indexer.js                                                 ├─ 2. Blast radius / impact
                                                                  ├─ 3. Theme token enforcer
                                                                  ├─ 4. Zero-emoji linter
                                                                  ├─ 5. i18n integrity check
                                                                  └─ 6. AST code health
```

---

## Tool Arsenal (CLI Reference)

All tools are located under `.agents/repo-intelligence-layer/scripts/` and invoked with Node.js:

```bash
node .agents/repo-intelligence-layer/scripts/<tool>.js <command> [args]
```

### 1. `depencies.js` — Core Knowledge Graph & AST Query Engine
- `query <term>` — Search file paths, purposes, and entity names by substring.
- `file <path>` — Print an objective **Identity Card** (framework, role, risk, exports, size, stability).
- `dependents <path>` — Who imports this file? (Direct upstream dependents).
- `deps <path>` — What does this file import? (Downstream dependencies).
- `callers <fnName>` — AST-derived caller sites with exact file references.
- `where <Component>` — JSX render sites across the codebase.
- `style <Component>` — Frequently passed props summary.
- `impact <path>` — Transitive blast radius calculation with risk rating.
- `similar <path>` — Structurally or semantically similar modules.
- `help` — CLI usage guide.

### 2. `blast-radius.js` — 6-Gate Pre-Commit Safety Chain
Chains 6 deterministic safety checks before changes are committed:
```bash
node .agents/repo-intelligence-layer/scripts/blast-radius.js <file_path>
```
1. **TypeScript Compilation:** Zero errors enforced via `tsc --noEmit`.
2. **Blast Radius Analysis:** Impacted direct & indirect dependents computed from `knowledge_graph.json`.
3. **Design Token Audit:** Rejects hardcoded Tailwind color classes and rogue hex/rgb values.
4. **Zero-Emoji Enforcement:** Flags any user-visible emoji strings in UI/JSX.
5. **i18n Integrity:** Flags untranslated hardcoded UI copy and validates translation bindings.
6. **AST Code Health:** Flags silent empty catch blocks, lingering debuggers, and reckless `any` casts.

Additional commands:
- `changed` — Runs safety checks over all staged/unstaged git changes.
- `tsc` — Standalone TypeScript validation gate.
- `impact <path>` — Direct blast-radius analysis.
- `full` — Full project audit summary.

### 3. `code-health.js` — Zero-Dependency AST Code Health & Anti-Pattern Linter
Scans directly via the TypeScript Compiler API with zero external lint dependencies:
- Flags empty catch blocks (`NO_EMPTY_CATCH` - silent failures).
- Flags lingering `console.log` / `console.info` in production code.
- Flags abandoned `debugger` statements.
- Flags explicit `any` escapes (`: any`, `as any`).
- Flags Rules of Hooks violations (hooks inside loops/conditionals).

Commands:
- `file <path>` — Per-file diagnostic with line numbers and snippets.
- `worst` — Top 10 files with the highest anti-pattern count.
- `summary` — Clean summary table across the repository.
- `scan` — Detailed full-project scan.

### 4. `route-navigator.js` — Navigation & Route Topology
Inspects `NavigationContainer`, stack screens, and bottom tabs:
- `tree` — Hierarchical navigation tree (Auth / Guest stack + MainTabs).
- `map` — Complete route roster with screen component paths and transition animations.
- `screen <Name>` — Detailed screen identity (component file, expected `route.params`, callers).
- `callers <Name>` — All files invoking `navigation.navigate('Name')` or `router.push()`.
- `params <Name>` — Extracted parameter keys expected by the route.

### 5. `supabase-mapper.js` — Schema, Table & RPC Mapper
Scans `.from('table')` and `.rpc('function')` call sites, linking them with migration SQL definitions:
- `map` — Overview of all Supabase tables, operations (SELECT, INSERT, UPSERT, DELETE), and usage count.
- `table <name>` — Column schema (from migrations), RLS policies, filters, and consuming files.
- `who <name>` — All files and line numbers accessing the table.
- `rpc` — All RPC function invocations.
- `migrations` — Registered SQL migrations with table/index breakdowns.
- `types [service]` — Discovered TypeScript interfaces and enum types per service.
- `rebuild` — Re-scans codebase and updates cache.

### 6. `theme-audit.js` — Design Token & Single-Theme Enforcer
Guarantees UI consistency against design rules (`var(--theme-accent)`, `theme.colors.*`):
- Flags hardcoded Tailwind color utilities (`text-purple-500`, `bg-emerald-400`, etc.).
- Flags static hex/rgba values inside component style sheets.
- Commands: `worst`, `summary`, `file <path>`, `scan`.

### 7. `emoji-linter.js` — Strict Zero-Emoji Enforcer
Scans unicode blocks across UI text nodes, props, and strings:
- Prioritizes `CRITICAL` user-facing JSX text nodes and button labels.
- Separates runtime strings (`ERROR`) from internal logger comments (`WARNING`).
- Commands: `ui`, `worst`, `summary`, `file <path>`, `scan`.

### 8. `i18n-indexer.js` — Bidirectional Translation Bridge
- Reverse searches human-readable Turkish/English copy to matching translation keys (`paywall.successTitle`).
- Discovers exact consuming files and line numbers.
- Identifies dead or orphan locale keys across `src/i18n/locales/`.
- Commands: `query <text_or_key>`, `build`.

---

## Typical Agentic Workflow

Autonomous coding agents follow an 8-step execution loop:

```
1. Task Arrival        → node .../depencies.js query <keyword>
2. Identity Inspection → node .../depencies.js file <path>
3. Side-Effect Check   → node .../depencies.js dependents <path>
4. Route Context       → node .../route-navigator.js screen <ScreenName>
5. Schema Context      → node .../supabase-mapper.js table <TableName>
6. Localization        → node .../i18n-indexer.js query <text>
7. Implementation      → Native AI edits (never PowerShell string replacement)
8. Closed-Loop Gate    → node .../blast-radius.js <path> (All 6 gates must pass)
```

---

## Live Dashboard

To run the continuous file-watcher daemon alongside the web dashboard:

```bash
bun run .agents/repo-intelligence-layer/analysis.tsx
```

- **Dashboard:** `http://localhost:5959`
- **Streaming SSE:** Real-time event stream of active file changes and AST updates.
- **Interactive Knowledge Graph:** Force-directed dependency topology with risk scoring.
