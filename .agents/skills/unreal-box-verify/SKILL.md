---
name: unreal-box-verify
description: Run and repair the Unreal Box repository validation gate. Use when asked to verify changes, fix CI or pnpm verify failures, or confirm a contribution is ready; do not use for implementing unrelated product work.
---

# Verify an Unreal Box change

Read the validation and trap sections of `AGENTS.md`. The gate has two tiers — pick the one the
situation calls for:

```bash
pnpm verify:changed     # a single task is done — ~30s, only what was touched
pnpm verify             # the batch is about to be published — ~3.5 min, the full gate
```

**Do not run the full gate after every small task.** It is ~3.5 minutes of mostly fixed cost, and
when several sessions share the worktree it goes red on other people's half-written files. The full
gate is owed before a push, a release, or a hand-off of the whole batch — not per task. `AGENTS.md`
§3 has the reasoning and the numbers.

For plugin-related validation, follow `docs/contributing/packaging.md`, and report repository
checks, plugin package inspection and native build/runtime acceptance as three separate results.

Whichever tier you ran, use the failing step's exact output to make the smallest legitimate repair,
then rerun that same tier. Do not declare success from a specialized command alone, and do not
report a `verify:changed` run as if the full gate had passed — name which tier you ran.

Common failures and the legitimate repair:

| Failing step | How to fix it |
|---|---|
| `security:secrets` | Move the value into `.env` and read `process.env`; see `.env.example` |
| `verify:official-endpoints` | The community core must not gain new official-server calls. Put official capabilities in `src/edition/`. The ratchet only tightens — `--update` refuses to raise the baseline |
| `lint` / `lint:changed` | `npx eslint --fix <file>`, then `pnpm format`, then fix the rest by rule id |
| `docs:check` | A bilingual pair was changed on one side only; update both |
| `typecheck` | Most often `src/preload/index.ts` changed without `src/preload/index.d.ts` |
| `test:run` | Debug one file with `npx vitest run <path>`; decide whether the implementation or the assertion is wrong |
| `NODE_MODULE_VERSION` in the output | The Node-ABI `better-sqlite3` cache is missing. `test:run` (full gate) rebuilds it for you; `test:related` (the `verify:changed` tier) does not — run `node scripts/better-sqlite3-abi.mjs ensure node` once. It does not touch `node_modules`, so the running app is unaffected |

These count as cheating and will get the contribution rejected: `it.skip` / `describe.skip`,
commenting out assertions, deleting a test that is in the way, lowering the coverage thresholds in
`vitest.config.ts`, adding your own files to `ignores` in `eslint.config.mjs`, or putting
`/* eslint-disable */` at the top of a new file.

If you are convinced a gate itself is wrong rather than your code, stop and tell the user why.
Do not route around it.

The gate no longer switches the `better-sqlite3` ABI — the Node and Electron artifacts are cached
side by side, so you can run it with the app open and there is nothing to restore afterwards.

Report **which tier you ran**, its result and final summary, how to exercise the affected behavior,
and any remaining blocker in plain language. If you ran only `verify:changed`, say so plainly and
say that the full gate is still owed before this work is published.
