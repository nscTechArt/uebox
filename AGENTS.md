# AGENTS.md

Instructions for AI coding agents working in this repository.
中文版：[AGENTS.zh-CN.md](AGENTS.zh-CN.md)（两份必须同步更新，CI 会检查）

---

## 0. This fork — read first

This section governs work **in this fork** and is not a contribution: keep it, and
`docs/agents/`, out of upstream PRs by cutting PR branches from `upstream/main`, never local `main`.

- **Verification is on-demand.** Write code, commit, hand off; commits land unverified. Run
  `pnpm verify*` (any variant), `lint`, `typecheck` or the vitest suite only when the user asks
  in the session or an invoked skill's instructions call for it. §3's rules apply whenever a
  check does run.
- **The single test file is still allowed** while implementing — a self-check, not the gate.
- **Issues, specs and triage labels** → `docs/agents/issue-tracker.md` (local markdown under
  `.scratch/<feature-slug>/`) and `docs/agents/triage-labels.md`. **Before exploring an area** →
  `docs/agents/domain.md`.

## 1. What this project is

**Unreal Box (虚幻盒子)** — an agent harness for Unreal Engine: a local runtime that lets an AI
agent actually operate an Unreal project. Electron + Vue 3 + TypeScript.

The other modules — project library, asset library, blueprint and material libraries,
notebooks and wikis — exist to serve the agent: they register what it acts on, feed it
material, and receive what it produces. Decide where a feature belongs by that relation.

This repository is the open-source desktop application. Local features work fully offline,
without an account or region gate. Optional AI and network vault features use services
explicitly configured by the user.

**Never** add telemetry, remote calls, or an account requirement to a local feature.

## 2. Setup

```bash
pnpm install
pnpm dev          # start the app (Electron)
```

Windows is the primary platform. The project pins Node in `.npmrc`; use `pnpm exec node` for
direct Node commands so they use the project runtime even when the system Node differs.

## 3. The gate — two tiers, and which one you owe

> **In this fork, §0 suspends the run schedule below.**

**While you work: run no gate.** Finish the feature first. At most run the one test file you are
writing (`pnpm exec vitest run <file>`).

**When the feature is done and you are about to commit:**

```bash
pnpm verify:changed     # only what you touched; once per commit, not per edit
```

**Before the work is published** — you are about to `git push`, cut a release, or hand the whole
batch over:

```bash
pnpm verify             # the full gate
```

**Run each tier once, at its point — never per edit.** The full gate is almost all fixed cost,
and it is repo-wide, so another session's half-written file turns **your** gate red (§5 rule 11).

The steps are defined in one place, `scripts/verify.mjs` (CI runs `pnpm verify --ci` on PRs and
pushes to `main`, but never the plugin/native checks, so green CI is not native acceptance);
every failing step says what to fix. You can leave the app running meanwhile.

`verify:changed` skips the full lint ratchet (`lint:changed` still covers new lines), typechecks
only the side you changed, and runs only the related tests. Its comparison base is
`$VERIFY_BASE` → `origin/main` → `main` → `HEAD`, so as an unpushed batch grows it widens to
cover the whole batch. To check strictly the task in front of you, pin it:
`VERIFY_BASE=HEAD pnpm verify:changed`.

Touched the main process, build config, or dependencies → add `--with-build` (packaging + offline
boot locally).

`verify:plugin` inspects a plugin package only when the change touches packaged plugin inputs, and
only the version selected by `VERIFY_PLUGIN_ENGINE`. **Selecting the target, or working without
Unreal installed** → [the packaging guide](docs/contributing/packaging.md#the-everyday-gate).
**Official installers, the update feed, releasing** →
[the same guide](docs/contributing/packaging.md#official-installers).

**When a gate is genuinely wrong, say so in the PR** and leave the check intact. Skipping,
deleting or `.skip`-ing tests, widening ESLint ignores, or loosening the coverage threshold is
routing around the gate, not fixing it.

## 4. Where code goes — the vertical slice

Almost every feature crosses the same seven layers. Skipping one is the most common failure mode.
Using tags as the example:

| # | Layer | Path | Responsibility |
|---|---|---|---|
| 1 | Model | `src/main/sqliteDataBase/models/tag.ts` | Table DDL + SQL |
| 2 | IPC handler | `src/main/sqliteDataBase/ipc/tag.ts` | `ipcMain.handle('db:tags:*')` |
| 3 | Preload bridge | `src/preload/index.ts` | `contextBridge` → `window.api.database.tag.*` |
| 4 | Preload types | `src/preload/index.d.ts` | Types for `window.api.*` |
| 5 | Renderer API | `src/renderer/src/api/tag.ts` | `tagAPI.*`, unwraps via `unwrapResult()` |
| 6 | Store | `src/renderer/src/store/modules/*` | Pinia, only if state is shared |
| 7 | View | `src/renderer/src/views/**` | Vue components |

Full walkthrough with a real worked example: [docs/contributing/vertical-slice.md](docs/contributing/vertical-slice.md).

For project vocabulary, read [CONTEXT.md](CONTEXT.md).

Other entry points: main-process IPC in `src/main/ipc/`, AI agents in `src/main/agent-v3/`.

Four areas sit outside that slice. Each carries its own obligation, and a change there is not done
until it is met:

| Area | Path | Obligation |
|---|---|---|
| Agent tools | `src/main/agent-v3/tools/` | Define with `defineTool` / `defineUeTool` and register in `registry.ts`; mind the `appSettingsManager` trap in §7; media inputs and write-tool receipts follow §5 rules 13–14 |
| Runtime skills (loaded by the in-app agent and the CLI) | `resources/skills/**`, `packages/cli/skills/**` | Conform to `resources/skills/SKILL_STANDARD.md` — gate step `verify:skills` |
| UE plugin | `plugin/UnrealAgentLink/` | Packaged inputs changed ⇒ rebuild the selected development zip and set `VERIFY_PLUGIN_ENGINE`, or gate step `verify:plugin` fails (§3) |
| `uebox` CLI | `packages/cli/` | Typechecked by the gate via `tsconfig.cli.json`; `pnpm verify:cli-package` (build + package check) is not in the gate — run it before publishing the package |

## 5. Hard rules

1. **No hard-coded colors or spacing.** Use the CSS variables in
   `src/renderer/src/assets/styles/theme.css`. See [docs/UI-Design-Standards.md](docs/UI-Design-Standards.md).
   The app has dark / light / high-contrast themes; a raw HEX breaks two of them.
2. **Check [docs/ui-components.md](docs/ui-components.md) before building UI.** The renderer has
   two component sources **on purpose**: our own `App*.vue` and what is left of `ant-design-vue`.
   The line: anything the user clicks or that pops up a layer is ours; form inputs are still antd.
   ESLint stops you if you pick wrong and names the right component in the error. Never wrap an
   antd component we already replaced.
3. **User-visible strings are bilingual.** Add the key to **both**
   `src/renderer/src/i18n/locales/zh-CN.ts` and `en-US.ts`. Never hard-code Chinese in a
   `.vue` template for new code.
4. **`src/preload/index.ts` and `src/preload/index.d.ts` change together.** Typecheck fails otherwise.
5. **The renderer never calls `ipcRenderer` directly.** Go through `window.api.*`, and wrap it in
   `src/renderer/src/api/*` using `unwrapResult()` so errors surface consistently.
   The wrapper is mandatory; `unwrapResult()` is the default, not the only option. It **throws**,
   which is right for reads whose caller cannot continue without the data. A surface whose callers
   must inspect the failure themselves — user-initiated actions that each report differently —
   may instead return a `{ success, error?, errorKey? }` shape, as long as every caller still goes
   through the wrapper and the reason is written in the module header.
   `src/renderer/src/api/updater.ts` is the worked example.
6. **New behaviour needs a test.** Put it in `tests/` or beside the source as `*.test.ts` — both
   are picked up. See [docs/contributing/testing.md](docs/contributing/testing.md).
7. **No new dependencies** unless the issue explicitly asks for one; network calls and telemetry
   follow §1.
8. **Keep the diff to the lines your task changes.** Leave other files' formatting as it is; a
   900-line diff for a 10-line feature will not be merged.
9. **Read before you write.** Check `docs/` for an existing spec on the area you're touching
   (`docs/ContextMenu组件使用规范.md`, `docs/router-meta.md`, …).
10. **For anything the user authored, the file on disk is the single source of truth.** The database
   is an index you can delete and rebuild; localStorage only holds UI preferences and one-shot flags.
   That is what makes the community edition's "your data stays yours" promise real — it has to be
   copyable, backup-able, and still there on another machine. Same for credentials: localStorage is
   plaintext, so use the main process's secure storage. Gate: `scripts/check-local-storage.mjs`;
   existing debt is registered in `scripts/local-storage.baseline.json` and may only shrink.

11. **This repo is often edited by several agent sessions at once.** Three rules:
    - **Stage your own files by path.** `git add -A` / `git add .` / `git commit -a` sweep
      another session's uncommitted work into your commit — nothing is lost, but the history
      is now wrong and the change is untraceable.
    - **When another session's work-in-progress turns the gate red, name it in your handoff.**
      Leave files outside your task untouched — reporting whose file blocks the gate is more
      useful than finishing it for them. Only one session runs the full `pnpm verify` at a
      time (schedule: §3).
    - **The four ratchet baselines are shared** (lint / colors / local-storage /
      official-endpoints under `scripts/`). They can only be updated one session at a time;
      concurrent updates always conflict. Before updating one, confirm you are the only
      session wrapping up.

12. **Read engine-authored files (`.uproject` / `.uplugin` / engine `ini`) only through
    `src/main/utils/ueTextFile.ts`** (`readUeTextFile` / `readUeJsonFile` / `decodeUeText`).
    One non-ASCII character (a Chinese project name) makes UE write the whole file as
    UTF-16LE, so a hard-coded `'utf-8'` read makes `JSON.parse` throw and the plugin install
    fail with an unreadable error. Write back as UTF-8 without a BOM.
    Gate: `scripts/check-ue-file-reads.mjs`.

13. **Media going to a model goes through `src/main/agent-v3/core/promptMedia.ts`:** an
    object-storage link first; only when storage is unconfigured, the model cannot take a link
    for that kind, or the upload fails, a per-file fallback (base64 for images, local path +
    `analyze_video` for video/audio) that never aborts the turn. A new media type plugs into
    that file. Tool output (editor screenshots) stays out of it.

14. **A write tool's receipt reports the engine's state after the write, and a partial
    failure never opens with success.** The model treats a receipt as fact. Every result
    field is read back from the engine after every mutation — compile included — has
    finished; a state that cannot be read back says `needs_compile` / `unknown`. If anything
    failed, the first line the model reads is "N succeeded / M failed" (C++: top-level
    `failed_count`); total failure throws. A new or changed write tool needs a test where the
    engine returns a value different from the input; batch tools add a partial-failure test.

## 6. Commits and PRs

- Conventional Commits with a **Chinese** description, matching existing history:
  `feat: 支持自定义标签颜色`, `fix: 修复打包产物无法启动的两个缺陷`, `feat!: 卸载工作流 Nexus`
- Branch name: `feat/<slug>`, `fix/<slug>`
- Fill in `.github/PULL_REQUEST_TEMPLATE.md` honestly, including whether `pnpm verify` passed.
- **Stop and ask the human before `git push` or opening a PR.** Committing locally is fine;
  publishing is the contributor's decision, not yours.
- Say in the PR that it is AI-assisted.

## 7. Traps

- **`NODE_MODULE_VERSION` from `better-sqlite3`** means the cached Node-ABI build is missing:
  `pnpm exec node scripts/better-sqlite3-abi.mjs ensure node` restores it without touching
  `node_modules` (which keeps the Electron build, so tests run fine with the app open).
- **`pnpm lint` is a ratchet, not a clean bill of health.** It lints the whole repo, but compares
  against a recorded backlog (`scripts/lint.baseline.json`). Existing violations are not your job
  to fix — they just must not grow.
- **If the gate says the backlog shrank**, run `pnpm lint:baseline:update` and commit the updated
  baseline. The ratchet only turns one way: `--update` refuses any increase.
- **`pnpm lint:changed` is what actually guards your code.** The ratchet still allows swapping 30
  existing problems for 30 different ones in the same file; the per-line gate does not.
- **Coverage thresholds (80%) apply to `src/renderer/**` only.** Main and preload are excluded
  from coverage but still must have tests for logic you add.
- **Never statically import `appSettingsManager` from an agent tool.** It starts with
  `import { logger } from './services'`, and that module drags in the WebSocket service and the
  task runner, ending at the `better-sqlite3` native binding. The tool registry is the entry point
  for every tool, so importing it statically makes **every** test that reaches the registry load
  that native module inside a vitest worker thread. The result is not "slow" — it is the
  **whole test process dying with a segfault** (0xC0000005 on Windows; individual tests pass but
  `pnpm test:run` crashes outright). Lazy-load it with `await import(...)` inside the function.
- **In `scoped` styles, `:global(...)` must be the entire selector.** Written as
  `:global([data-theme='dark']) .foo`, Vue drops everything after it and compiles to a bare
  `[data-theme='dark']` — that is `<html>` itself, so the rule hits the whole app. (This really
  happened: one `filter` turned the entire preferences screen white.) **Write the ancestor
  selector directly**; `scoped` appends `[data-v-xxx]` to the last segment, so it already matches
  only this component. Gate: `tests/unit/scoped-global-selector.test.ts`.

## 8. When you are stuck

Keep the task at its full scope and stop to report: what you tried, what the gate said, and what
you need decided. A half-finished PR with an honest description is more useful than a green one
that skipped the hard part.
