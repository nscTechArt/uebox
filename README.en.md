<p align="center">
  <img src="build/icon.png" width="96" alt="UE Box">
</p>

<h1 align="center">UE Box</h1>

<p align="center">
  <b>The open-source AI agent that works directly in the Unreal Editor</b><br>
  Give it a goal and it finishes the job inside the project you already have open —
  place Actors, edit Blueprints, wire materials, compile C++.<br>
  Every step can be approved. Every change can be verified.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="Unreal Engine" src="https://img.shields.io/badge/Unreal%20Engine-5.0%20~%205.8-0e1128">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%2F%20Linux%20from%20source-6b7280">
  <img alt="Built with" src="https://img.shields.io/badge/Electron%20%2B%20Vue%203%20%2B%20TypeScript-42b883">
</p>

<p align="center">
  <a href="https://uebox.ai/en">Website</a> ·
  <a href="https://github.com/ueboxai/uebox/releases">Download</a> ·
  <a href="https://uebox.ai/guide/">Manual (Chinese)</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="README.md">中文</a>
</p>

<!-- TODO: replace the still below with a GIF under 10 seconds (give a goal → agent places Actors → the engine really changed), stored under website/public/shots/ -->

![A real exchange: the question, the tool calls, the answer starting](website/public/shots/ai-conversation.png)

---

## What it is

A desktop app. You bring a model provider; it connects to your running Unreal Editor
through the UnrealAgentLink plugin and does the work with a hundred-plus engine tools
and 25 built-in skills. Routine operations just run; risky ones pause for your approval.
"Done" isn't its call to make — after it edits, it goes back into the engine to check,
and then has to account for itself.

Beyond levels, Blueprints, materials, assets and C++, it also handles animation
retargeting, UMG, Sequencer shots, PIE runtime checks, geometry editing and project
audits. → [Full capabilities and limits](https://uebox.ai/guide/capabilities)

The agent is the product. The project library, asset library, Blueprint and material
libraries, and notebooks each have a full standalone UI and can be used on their own,
but structurally they serve the agent: they register what it acts on, feed it material,
and receive what it produces.

<!-- TODO: "community core" has to be explained, or readers will wonder what is being held back.
     A. Another edition / separately provided components exist (e.g. the asset server, a hosted gateway)
        → add one sentence after the line below: what is in this repo and what is not.
     B. This is the only edition → drop the words "community core" and keep the rest of the sentence.
     Use the same sentence in the manual's Team page ("where does the server come from"). -->

This repository is the **community core**: no account, no dependency on our servers,
and you can build all of it yourself.

---

## Up and running in three minutes

1. **Install** (Windows): [GitHub Releases](https://github.com/ueboxai/uebox/releases) · [website](https://uebox.ai/en).
   Every local feature works the moment it opens.
2. **Set up a model**: go to **Preferences → AI → Model Sources**, add your own provider,
   then bind a model to the _Chat_ role — _Chat_ alone is enough, the other roles fall back to it.
   Local inference (Ollama, LM Studio, llama.cpp) and self-hosted gateways (LiteLLM, One API)
   are in the provider catalog too. The model must support tool calling, or it cannot operate the engine.
   The key field also accepts an environment variable name or a command such as `!op read …`.
3. **Import your project**: **Projects → import your `.uproject`**. The connection plugin is installed
   into `<project>/Plugins/UnrealAgentLink/` automatically (you can turn this off or right-click to remove it —
   [exactly what it touches](https://uebox.ai/guide/plugin#它怎么装上的)).
4. **Say the first thing**: click **Open project**; once the editor is up the plugin connects by itself.
   Open **AI session** and try "How many lights are in this level?" — read-only, just to confirm the link is live.

Stuck? → [First run](https://uebox.ai/guide/first-run) · [Connect Unreal](https://uebox.ai/guide/plugin)

<!-- TODO: check the UI labels above against the English build: "Preferences → AI → Model Sources", "Projects", "Open project", "AI session".
     The Chinese manual gives the model path as 设置 → 模型 → 添加服务商 / 默认模型 → 对话; one of the two is stale. -->

---

## See it work

One task, four frames:

|                                                                                                                               |                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| ![Tool call](website/public/shots/ai-tool-call.png)<br>**Engine tool call** — name, arguments and return value, all laid open | ![Changes](website/public/shots/engine-changes.png)<br>**This round's changes** — what it touched in the engine                                   |
| ![Review](website/public/shots/engine-review.png)<br>**Review** — the verdict after the agent re-read the engine with read-only tools | ![Self-check](website/public/shots/engine-selfcheck.png)<br>**Account for it** — answering each finding: what it missed, what it added on its own |

**Already using Codex, Claude Code or Cursor?** Switch on the MCP server and plug UE Box in as a tool
provider — your client gains a hundred-plus Unreal tools at once. Local connections only, read-only by default.
→ [MCP](https://uebox.ai/guide/mcp)

It ships with these too, each usable on its own:

|                                                                                              |                                                                             |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| ![Projects](website/public/shots/home-projects.png)<br>Project library: engines and projects | ![Assets](website/public/shots/asset-library.png)<br>Asset library          |
| ![Blueprints](website/public/shots/blueprint-library.png)<br>Blueprint library               | ![Materials](website/public/shots/material-library.png)<br>Material library |
| ![3D viewer](website/public/shots/model-viewer-wireframe.png)<br>3D viewer                   | ![Notebooks](website/public/shots/notebooks.png)<br>Notes and notebooks     |

---

## Network and data

- No account. Keys are encrypted on your machine, and requests go straight to the provider
  you configured — never through a server of ours.
- By default the only network activity is an update check, which checks and never downloads.
  A build you package yourself with no update feed configured makes no network request at all
  (see [updateFeed.ts](src/main/services/updater/updateFeed.ts)).
- AI, web search, image generation and cloud drives connect only when you use them.
  With a local model, AI stays on your machine too.

---

## Platform support

|         | Installer         | Engine discovery                      | Prebuilt UnrealAgentLink plugin            |
| ------- | ----------------- | ------------------------------------- | ------------------------------------------ |
| Windows | ✅                | ✅                                    | ✅                                         |
| macOS   | Build from source | ✅ common directories + manual adding | Build and release validation not finished  |
| Linux   | Build from source | Not supported yet                     | —                                          |

<!-- TODO: fill in the Linux "prebuilt plugin" cell with the real status -->

**Windows is the primary platform** and where features are verified. macOS discovers engines in
common shared installation directories, lets you register engine folders or editor `.app` bundles
by hand, and detects running UE4 / UE5 editors and their project paths.

The UnrealAgentLink plugin source lives in [`plugin/UnrealAgentLink`](plugin/UnrealAgentLink)
under its own [MIT license](plugin/UnrealAgentLink/LICENSE).

---

## Add features with AI (no coding required)

The stance of this project: **experiment freely while developing, concede
nothing at the acceptance gate.**

The repo ships a spec for AI agents to read ([AGENTS.md](AGENTS.md)) and a
one-command acceptance gate (`pnpm verify`). You just tell your AI coding assistant
what you want:

> Add a feature to UE Box: asset library tags should support custom colors.
> Read AGENTS.md at the repo root first and follow it, add tests when you're
> done, then run `pnpm verify` until everything is green. Don't push — wait for
> my confirmation.

It reads the architecture, writes the code and runs the tests itself.
→ **[Three-step guide](docs/contributing/vibe-coding.md)**

With Codex, just open and trust this repository: the root `AGENTS.md`, the
`.codex/` sandbox config and the `.agents/skills/` workflows apply
automatically. See [`.codex/README.md`](.codex/README.md).

---

## Run from source

```bash
pnpm install
pnpm dev
```

After changing code:

```bash
pnpm verify
```

One command runs every CI gate (secret scan → official-endpoint ratchet → lint
→ changed-line lint → typecheck → unit tests). On failure it tells you exactly
what to fix and which command to run. **You can leave the app running while it
runs** — the gate does not touch the native module.

To produce an installer, cut a release, or get unstuck from the `better-sqlite3`
ABI, see [Packaging, releasing and the native module](docs/contributing/packaging.md).

---

## Documentation

| I am…                              | Start here                                                                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| A user who wants to get going      | [Manual](https://uebox.ai/guide/) · [First run](https://uebox.ai/guide/first-run) · [Connect Unreal](https://uebox.ai/guide/plugin) (Chinese)      |
| A user who wants a feature         | [Add a feature with AI](docs/contributing/vibe-coding.md) · [Request one](../../issues/new?template=feature_request.yml)                           |
| A developer                        | [Contributing](CONTRIBUTING.md) · [Vertical slice](docs/contributing/vertical-slice.md) · [Testing guide](docs/contributing/testing.md)            |
| A release manager                  | [Packaging and releasing](docs/contributing/packaging.md)                                                                                          |
| An AI agent                        | [AGENTS.md](AGENTS.md)                                                                                                                             |
| A designer                         | [UI design standards](docs/UI-Design-Standards.md)                                                                                                 |

More topics live in [`docs/`](docs/).

Changelog: [CHANGELOG.md](CHANGELOG.md) ·
Security policy: [SECURITY.md](SECURITY.md) ·
Third-party components: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

---

## License

App: [Apache License 2.0](LICENSE) · UnrealAgentLink plugin: [MIT](plugin/UnrealAgentLink/LICENSE)

Unreal Engine is a trademark of Epic Games, Inc. This project is not affiliated with Epic Games.
