---
name: unreal-box-ship
description: Prepare an Unreal Box contribution for a local commit when the user explicitly asks to ship, commit, or prepare a pull request. Validate and stage only the intended change, then stop before push or PR publication unless separately approved.
---

# Prepare an Unreal Box contribution

Read the commit and pull-request rules in `AGENTS.md`. **This is the tier where the full gate is
owed** — the per-task `verify:changed` runs do not substitute for it. Run `pnpm verify` (add
`--with-build` if the batch touched the main process, build config, or dependencies); do not
proceed to a commit while the gate is failing.

Inspect `git status`, the diff, and the diff stat. Separate the requested contribution from unrelated
work already present in the worktree. Never discard or include unrelated changes just to make the
commit convenient.

If needed, create a local `feat/<slug>` or `fix/<slug>` branch. Stage explicit file paths rather than
using `git add -A`, and use a Conventional Commit with a Chinese user-outcome description. A local
commit is allowed when the user asked to ship or commit.

After the local commit, report the branch, commit message, commit stat, validation result, and an
honest pull-request draft based on `.github/PULL_REQUEST_TEMPLATE.md`, including AI assistance.

Stop before `git push`, `gh pr create`, or any equivalent publication. Ask for explicit human
approval for that separate external action.
