---
name: unreal-box-feature
description: Implement or modify a feature in the Unreal Box repository — the Electron app (Vue UI, Pinia, renderer APIs, preload, IPC, SQLite, shared types, i18n, tests), the agent-v3 tools in the main process, the runtime skills under resources/skills, the UnrealAgentLink UE plugin, or the uebox CLI. Use for feature and bug-fix implementation in this repository; do not use for read-only explanation or review.
---

# Implement an Unreal Box feature

Read `AGENTS.md` completely, then read `docs/contributing/vertical-slice.md` and any topic-specific
document relevant to the requested area — `docs/ui-components.md` before any UI work, `CONTEXT.md`
for project vocabulary.
Treat those repository documents as authoritative.

Before editing, trace the existing owner path from persistence or main-process behavior through the
preload boundary to the renderer and UI. Identify which parts already exist so the change remains
narrow. Share the intended files and user-visible outcome as a short progress update, then continue
unless the request is materially ambiguous or needs new authority.

Implement only the layers the behavior actually needs. Preserve these non-obvious invariants:

- community-edition paths stay offline and account-free, and gain no new dependency, network call,
  or telemetry unless the request explicitly asks for it;
- `src/preload/index.ts` and `src/preload/index.d.ts` change together;
- renderer IPC goes through `window.api.*` and a renderer API wrapper using `unwrapResult()`;
- user-visible strings are added to both locale files;
- UI uses the component source `docs/ui-components.md` prescribes: our own `App*.vue` for anything
  the user clicks or that pops up a layer, `ant-design-vue` only for form inputs — never wrap an
  antd component we already replaced;
- styling uses the theme variables, while user-owned color data may remain a color value;
- anything the user authored lives on disk as the single source of truth: the database is a
  rebuildable index, `localStorage` holds only UI preferences and one-shot flags, and credentials go
  through the main process's secure storage (gate: `scripts/check-local-storage.mjs`; its baseline
  may only shrink);
- schema changes include an idempotent migration for existing databases;
- unrelated dirty-worktree changes and formatting are preserved.

Two traps from `AGENTS.md` §7 that surface late or not at all:

- an agent tool never statically imports `appSettingsManager`; lazy-load it with `await import(...)`
  inside the function, or the whole vitest process segfaults;
- in `scoped` styles, `:global(...)` must be the entire selector — write the ancestor selector
  directly instead.

Areas outside the seven-layer slice carry one extra obligation each:

| Area | Where | Extra obligation |
|---|---|---|
| Agent tools | `src/main/agent-v3/tools/` | Define with `defineTool` / `defineUeTool`, register in `registry.ts`, test beside the tool |
| Runtime skills | `resources/skills/**`, `packages/cli/skills/**` | Conform to `resources/skills/SKILL_STANDARD.md`; `verify:skills` enforces it |
| UE plugin | `plugin/UnrealAgentLink/` | Packaged inputs changed ⇒ rebuild the selected development zip (`VERIFY_PLUGIN_ENGINE` or `verify:plugin --engine`) or `verify:plugin` fails. Other engine versions are rebuilt only for a release |
| CLI | `packages/cli/` | The gate typechecks it via `tsconfig.cli.json`; `pnpm verify:cli-package` (build + package check) is not in the gate — run it before the package is published |

Add focused tests for new behavior. Include the normal path and the meaningful boundary and failure
paths; prefer pure-logic tests when mounting a component is unnecessary. Read
`docs/contributing/testing.md` when choosing the test location or harness.

Run `pnpm verify:changed` after implementation (~30s, only what you touched) and fix failures
without weakening a gate. **Do not run the full `pnpm verify` here** — that tier is owed before the
work is published, not per task; see `AGENTS.md` §3. If it goes red on a file you did not touch,
another session's work-in-progress is blocking it: say so in your report instead of editing that
file (`AGENTS.md` §5 rule 11). If this feature touched the main process, build configuration, or
dependencies, note it in your report: the eventual full run needs `pnpm verify --with-build`.

Report the observable result, how the user can verify it, which gate tier you ran, and any
remaining gap.
Do not push or open a pull request without explicit human approval.
