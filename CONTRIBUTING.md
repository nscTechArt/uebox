# Contributing

中文版：[CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)

Vibe coding (building with an AI assistant) is welcome. Not knowing how to code is not a barrier;
not running the tests is. The repository ships the spec your AI reads ([AGENTS.md](AGENTS.md)) and
an acceptance gate (`pnpm verify`). You only need to say what you want.

---

## Pick your path

### I'm a user and I want a feature

Two options:

- **Do it yourself** (fastest): follow
  [Add a feature with AI](docs/contributing/vibe-coding.md) to set up, then give the request
  template to your AI assistant.
- **File a request**: open a
  [Feature request](../../issues/new?template=feature_request.yml). Say what you want and where
  you would use it. You do not need to say how to build it.

You can paste a finished issue into your AI assistant and have it build the feature.

### I write code

1. Read [AGENTS.md](AGENTS.md): architecture layers, hard rules, gates;
2. Read [the vertical slice guide](docs/contributing/vertical-slice.md): which layer the code goes in;
3. Write the code and the tests;
4. Run `pnpm verify:changed` on each commit and `pnpm verify` once before the PR, fully green;
5. Self-check against the [Definition of Done](docs/contributing/definition-of-done.md);
6. Open a PR.

### I'm an AI agent

Read [AGENTS.md](AGENTS.md) (Chinese version: [AGENTS.zh-CN.md](AGENTS.zh-CN.md)). It is the single
source of truth. Ask a human before `git push` or opening a PR.

---

## Quick start

Requires Node.js 24.21.0 and pnpm 10.28.2.

```bash
pnpm install
pnpm dev
```

### The gate has two tiers

| When                                 | Command               | Time          | Scope                                 |
| ------------------------------------ | --------------------- | ------------- | ------------------------------------- |
| While working                        | none                  | -             | At most the test file you are editing |
| Feature done, on each commit         | `pnpm verify:changed` | about 30 s    | Only what you changed                 |
| Before the batch goes out (push, PR) | `pnpm verify`         | about 3.5 min | The full set CI runs, whole repo      |

Run one test file: `pnpm exec vitest run <file>`.

`verify:changed` does not replace `pnpm verify`. You do not need to close the app to run either.
What each step checks is listed in the
[architecture and gate page](website/develop/architecture.md).

If you change packaged plugin inputs (files under `plugin/UnrealAgentLink/` that ship in the
distribution), the gate needs a target engine version, or `none` when Unreal is not installed. See
[the packaging guide](docs/contributing/packaging.md#the-everyday-gate). UI and docs changes need
no plugin ZIP and no Unreal installation.

To produce an installer, cut a release, or get unstuck from the `better-sqlite3` ABI, see
[Packaging, releasing and the native module](docs/contributing/packaging.md).

### UI strings and terminology

- Add every user-visible string to both `zh-CN.ts` and `en-US.ts`.
- [CONTEXT.md](CONTEXT.md) defines the terms. `src/renderer/src/i18n/terminologyGuard.test.ts`
  scans both language packs and the main-process strings. It fails on banned words (for example
  「会话」, 「聊天」, 「回合」) and prints the replacement.

### Recommended editor setup

[VSCode](https://code.visualstudio.com/) +
[ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) +
[Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) +
[Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar)

---

## What review looks at

- Whether `pnpm verify` is genuinely green
- Whether the feature actually works, not only whether tests pass
- Whether the diff touches only what it needed to
- Whether new code has tests
- Whether user-visible strings exist in both `zh-CN` and `en-US`

Review does not look at: whether you are a professional programmer; whether an AI wrote the code
(tick the box in the PR template, it costs nothing); which AI assistant you used; whether the first
version is elegant (if it passes the gate and works, it gets refined in review).

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

Do not report vulnerabilities in a public issue. Email the maintainers as described in
[SECURITY.md](SECURITY.md).

---

## Code of Conduct

By participating you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Apache License 2.0. By contributing you agree your code is released under the same license.
