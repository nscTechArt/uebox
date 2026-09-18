# Contributing

中文版：[CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)

This project's stance is simple:

> **Experiment freely while building; give no ground at review.**

We **explicitly welcome vibe coding** — turning an idea into code with an AI assistant. Not
knowing how to code is not a barrier. Not running the tests is. This repository ships the spec
your AI reads and a one-command acceptance gate. The rest is just describing what you want.

---

## Pick your path

### 🙋 I'm a user and I just want a feature

Two options:

- **Do it yourself** (fastest): follow
  [Add a feature with AI](docs/contributing/vibe-coding.md) — three setup steps, then hand the
  request template to your AI assistant.
- **File a request**: open a
  [Feature request](../../issues/new?template=feature_request.yml). Describe _what you want_, not
  _how to build it_.

By the way: a well-written issue is excellent AI input. Once it's filed, you can paste the whole
issue into your AI assistant and have it build the thing.

### 👩‍💻 I write code

1. Read [AGENTS.md](AGENTS.md) — architecture layers, hard rules, gates;
2. Read [the vertical slice guide](docs/contributing/vertical-slice.md) — where code goes;
3. Write the code and the tests;
4. Get `pnpm verify` fully green;
5. Self-check against the [Definition of Done](docs/contributing/definition-of-done.md);
6. Open a PR.

### 🤖 I'm an AI agent

Read [AGENTS.md](AGENTS.md). That is your single source of truth. Stop and ask a human before
`git push` or opening a PR.

---

## Quick start

```bash
pnpm install
pnpm dev
```

After changing code:

```bash
pnpm verify
```

That one command runs every gate CI runs, and tells you exactly what to fix when something fails.
It also restores the `better-sqlite3` Electron ABI on the way out, so you can go straight back to
`pnpm dev`.

To produce an installer, cut a release, or get unstuck from the native module ABI, see
[Packaging, releasing and the native module](docs/contributing/packaging.md).

### Recommended editor setup

[VSCode](https://code.visualstudio.com/) +
[ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) +
[Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) +
[Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar)

---

## What we review — and what we don't

**We do review:**

- Whether `pnpm verify` is genuinely green
- Whether the feature actually works (not just whether tests pass)
- Whether the diff touches only what it needed to
- Whether new code has tests
- Whether user-visible strings exist in both `zh-CN` and `en-US`

**We don't review:**

- Whether you're a "real programmer"
- Whether an AI wrote the code (welcome — tick the box in the PR template, it costs you nothing)
- Which AI assistant you used
- Whether your first implementation is the most elegant one (if it passes the gate and works,
  we'll refine it together)

---

## Commit convention

Conventional Commits with a **Chinese** description, matching existing history:

```
feat: 支持自定义标签颜色
fix: 修复打包产物无法启动的两个缺陷
feat!: 卸载工作流 Nexus          ← breaking change uses !
docs: 补充垂直切片说明
chore: 升级 electron-builder
```

Branch naming: `feat/<slug>`, `fix/<slug>`.

---

## Reporting bugs

Open a [Bug report](../../issues/new?template=bug_report.yml) with:

- Version number (see the About page)
- Operating system
- Steps to reproduce
- Screenshot or log of the error

---

## Security issues

**Do not** report security vulnerabilities in a public issue. Use GitHub's private
[Security Advisory](../../security/advisories/new) flow instead.

---

## Code of Conduct

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Apache License 2.0. By contributing you agree your code is released under the same license.
