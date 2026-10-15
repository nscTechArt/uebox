# Add a feature to Unreal Box with AI (no coding required)

中文版：[vibe-coding.zh-CN.md](vibe-coding.zh-CN.md)

You don't need to know how to code. You need a computer, an AI coding assistant, and one
sentence describing what you want.

The repository ships the spec your AI reads (`AGENTS.md`) and acceptance gates (`pnpm verify:changed`
and `pnpm verify`). Your AI reads the spec, writes the code, and runs the tests. You describe what
you want and check the result.

---

## Three steps to get set up

### 1. Install the tools

- [Node.js 24.21.0](https://nodejs.org/)
- pnpm 10.28.2: after installing Node, run `npm i -g pnpm@10.28.2`
- An AI coding assistant — for example [Claude Code](https://claude.com/claude-code),
  [Codex](https://developers.openai.com/codex/), Cursor, or GitHub Copilot
- [Git](https://git-scm.com/)

**Using Codex?** Open this repository and mark it as trusted. Codex automatically reads `AGENTS.md`,
loads the safe project defaults and command policy from `.codex/`, and discovers the repository
workflows under `.agents/skills/`. You can simply describe the feature, or invoke
`$unreal-box-feature` explicitly.

### 2. Get the project onto your machine

Just say this to your AI assistant — it will run the commands for you:

> Clone https://github.com/<repo> locally, `cd` into it, run `pnpm install`, then run `pnpm dev`
> and tell me whether the app starts.

The first `pnpm install` takes several minutes because native modules get compiled.

### 3. Confirm it runs

If the Unreal Box window opens, your environment is ready.

---

## The request template

Describe what you want, not how to build it. The AI finds the implementation path.

Copy this and replace the bracketed parts:

```
I want to add a feature to Unreal Box: [one sentence describing what you want].

Specifically:
- [where the user sees or clicks it]
- [what happens when they do]
- [any edge cases and how you want them handled]

Please:
1. Read AGENTS.md in the repo root first and follow it;
2. Before writing anything, read the relevant code and tell me which files you plan to
   change and why;
3. Add tests for what you implement;
4. Run `pnpm verify:changed` when the feature is done; before handing me the commit, run the
   full `pnpm verify` once and keep fixing until it is fully green;
5. Once it's green, give me a commit message that follows the convention — but
   **do not push, wait for my confirmation**.
```

### A real example

```
I want to add a feature to Unreal Box: asset library tags should support custom colors.

Specifically:
- When creating or editing a tag in tag management, I can pick a color
- The tag then renders in that color in the list
- If I don't pick one, it uses a default — not picking must never cause an error

Please:
1. Read AGENTS.md in the repo root first and follow it;
2. Before writing anything, read the relevant code and tell me which files you plan to
   change and why;
3. Add tests for what you implement;
4. Run `pnpm verify:changed` when the feature is done; before handing me the commit, run the
   full `pnpm verify` once and keep fixing until it is fully green;
5. Once it's green, give me a commit message that follows the convention — but do not push,
   wait for my confirmation.
```

(In this example the database column already exists and the UI has no entry for it, so the AI
should read the code first and report "no database change needed". Walkthrough:
[vertical-slice.md](vertical-slice.md), written in Chinese with an English summary.)

---

## Reviewing: three things to check

When the AI says "done", check three things.

### 1. Is `pnpm verify` actually green?

Ask it to paste the final output. The last line should be:

```
✅ 门禁全绿，可以提交了。   ("gate is green, ready to commit")
```

If it says "there's a small test issue but it doesn't affect the feature" or "I skipped that
test for now" — **that is not done**. Reply:

> Don't skip tests. Get `pnpm verify` genuinely green — no skipping, no deleting tests, no
> lowering thresholds.

### 2. Does the feature actually work?

```bash
pnpm dev
```

Click through it yourself. A green gate shows the code does not break; it does not show the
feature behaves correctly.

### 3. Did it change only what it needed to?

> Show me `git status` and `git diff --stat` for this change.

If a "tag color" feature touched 40 files, it probably reformatted a pile of unrelated code.
Tell it to revert the unrelated changes.

---

## When the AI gets stuck

| It says                                       | You reply                                                                                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| "Tests won't run / NODE_MODULE_VERSION error" | "Run `node scripts/better-sqlite3-abi.mjs ensure node` once — it fills the missing Node-ABI cache without touching the running app" |
| "Lint reports tons of pre-existing errors"    | "`pnpm lint:changed` only reports lines you touched. Those are yours — fix them"                                                    |
| "I'm not sure which layer this belongs in"    | "Read `docs/contributing/vertical-slice.md` and locate it on the seven-layer map"                                                   |
| "This needs a database schema change"         | "Confirm that's really true first. See section 3 of `vertical-slice.md` — adding a column requires an idempotent migration"         |
| "typecheck says the property doesn't exist"   | "Did you change `src/preload/index.ts` without updating `index.d.ts`? They must change together"                                    |
| It loops without fixing it                    | "Stop. Send me what you tried and the exact error text — we'll open an issue"                                                       |

If you are stuck, open an issue with the exact error text. That helps more than an implementation
that runs but is wrong.

---

## Submitting your work

1. Have the AI create a branch and write the commit message (Conventional Commits with a Chinese
   description, e.g. `feat: 支持自定义标签颜色`);
2. **It will stop and ask you before pushing** — that's required by the spec. Confirm, then let it continue;
3. Open a PR and fill in the template honestly, including whether `pnpm verify` passed and whether
   AI assisted.

Ticking "AI assisted" does not count against you. Review looks at the diff and the gate, not at who
typed it.

If part of the work is unfinished, say so in the PR under `## Unfinished / need help`.
Maintainers will help finish it.

Full checklist: [definition-of-done.md](definition-of-done.md)
