# Definition of Done

中文版：[definition-of-done.zh-CN.md](definition-of-done.zh-CN.md)

**Experiment freely while building; give no ground at review.** This is what "done" means. The PR
template maps to it line by line. An AI agent must walk this list before claiming completion.

---

## A. Gates

This list is the **publish** checkpoint, not the per-task one. Finishing a single task only owes
`pnpm verify:changed` (~30s); the full gate is owed once, before the batch goes out. See
[AGENTS.md](../../AGENTS.md) §3.

- [ ] Each task in this batch passed `pnpm verify:changed` when it was finished
- [ ] `pnpm verify` is fully green; the last line reads `✅ 门禁全绿，可以提交了。`
- [ ] No `.skip`, no deleted tests, no commented-out assertions, no lowered coverage thresholds,
      no widened ESLint ignores, no `/* eslint-disable */` at the top of a new file
- [ ] If the main process, build config, or dependencies changed: `pnpm verify --with-build` also ran

## B. The feature itself

- [ ] `pnpm dev` starts and the feature was **clicked through by a human**, not just green in tests
- [ ] The happy path works
- [ ] Edge cases are handled (empty, `null`, over-long input, duplicates, out of range)
- [ ] Failures surface a message to the user — no blank screen, no silent failure
- [ ] Nothing existing broke (spot-check the neighbouring features)

## C. Code

- [ ] Placed correctly on the seven-layer map in [vertical-slice.md](vertical-slice.md); no layer skipped
- [ ] If `src/preload/index.ts` changed, `src/preload/index.d.ts` changed with it
- [ ] The renderer does not call `ipcRenderer` directly — it goes through `window.api.*` →
      `src/renderer/src/api/*` → `unwrapResult()`
- [ ] No hard-coded HEX colors or magic pixel values; CSS variables from `theme.css` are used
- [ ] Checked in both dark and light themes, legible in both
- [ ] No new dependencies, network calls, or telemetry (if there are, justify them in the PR)
- [ ] No unrelated files reformatted — every file in `git diff --stat` is one you meant to touch

## D. Tests

- [ ] New logic has tests
- [ ] Happy path, edge cases, and error path are all covered
- [ ] Tests live in `tests/` or beside the source as `*.test.ts`
- [ ] Tests don't depend on real user data directories or real network access

## E. Copy and i18n

- [ ] New user-visible strings were added to **both** `zh-CN.ts` and `en-US.ts`
- [ ] If the copy is on a login / subscription / payment / authorization path, the key was added to
      `CRITICAL_KEYS` in `src/renderer/src/i18n/criticalPathCoverage.test.ts`
- [ ] No hard-coded Chinese in new `.vue` templates

## F. Database (only if you touched the schema)

- [ ] The new column is in the `CREATE TABLE` statement
- [ ] A separate idempotent migration exists (`PRAGMA table_info` check → `ALTER TABLE ADD COLUMN`)
- [ ] The new column is nullable or has a default
- [ ] The migration has a test, including "running it twice doesn't fail"
- [ ] The PR describes **what happens to existing users after they upgrade**

## G. Commit

- [ ] Branch is named `feat/<slug>` or `fix/<slug>`
- [ ] Commit message is Conventional Commits with a Chinese description, e.g. `feat: 支持自定义标签颜色`
- [ ] Breaking changes use `!` (e.g. `feat!: 卸载工作流 Nexus`)
- [ ] The PR template is filled in honestly, including whether AI assisted
- [ ] **A human was asked before pushing or opening the PR**

---

## If you didn't finish

Don't fake completion to satisfy this list.

Add a `## Unfinished / need help` section to the PR description and state:

- which item you couldn't meet;
- what you tried;
- where you got stuck (paste the exact error).

**We will help you finish that PR.** A green PR that routed around the hard part just hands the
problem to the next person.
