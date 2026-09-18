<p align="center">
  <img src="build/icon.png" width="96" alt="UE Box">
</p>

<h1 align="center">UE Box (Community Edition)</h1>

<p align="center">
  <b>An agent harness for Unreal Engine</b><br>
  Give it a goal and let an AI finish the job inside the project you already have open —
  place actors, edit blueprints, wire materials, compile C++.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <img alt="Unreal Engine" src="https://img.shields.io/badge/Unreal%20Engine-5.0%20~%205.8-0e1128">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-6b7280">
  <img alt="Built with" src="https://img.shields.io/badge/Electron%20%2B%20Vue%203%20%2B%20TypeScript-42b883">
</p>

<p align="center">
  <a href="https://uebox.ai">Website</a> ·
  <a href="https://github.com/ueboxai/uebox/releases">Download</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="README.md">中文</a>
</p>

![A real exchange: the question, the tool calls, the answer starting](website/public/shots/ai-conversation.png)

---

## What it is

A local runtime that lets an AI agent actually operate an Unreal project — model
access, a hundred-plus engine tools, built-in skills, step-by-step approval and
result verification. Electron + Vue 3 + TypeScript, Apache-2.0.

The agent is the product. The project library, asset library, blueprint and material
libraries, and notebooks each have a full standalone UI and can be used on their own,
but structurally they serve the agent: they register what it acts on, feed it material,
and receive what it produces.

This repository is the **community core**: it runs fully offline — no account,
no dependency on our servers, no region gating. Every local feature works right
after install; AI features just need your own model API key, stored only on your machine.

No update feed is baked in: nothing points at an update server unless you configure
one, and with none configured the app makes no network request for it at all
(see [updateFeed.ts](src/main/services/updater/updateFeed.ts)).

UnrealAgentLink, the plugin that talks to the engine, is included in
[`plugin/UnrealAgentLink`](plugin/UnrealAgentLink) under its own
[MIT license](plugin/UnrealAgentLink/LICENSE). On project
import the app installs the bundled prebuilt copy into
`<project>/Plugins/UnrealAgentLink/` — the binary is there so users who can't
compile get it working out of the box. Use this repository's build scripts to
compile it yourself; right-click a project card to remove the installed copy.

Platforms: **Windows is the primary platform** and where features are verified.
macOS and Linux build and launch. macOS supports engine discovery in common shared
installation directories and manual registration of engine folders or editor `.app` bundles.
macOS also detects running UE4 / UE5 editors and their project paths. Mac plugin binary builds
and release validation remain unfinished; Linux engine auto-discovery is not yet supported.

---

## See it work

"Done" isn't its call to make — after it edits, the machine goes back into the
engine to check, and then the agent has to account for itself. One task, four frames:

<!-- TODO: add a 10-second GIF here (give a goal → agent places actors → the engine really changed), stored under website/public/shots/ -->

|                                                                                                                               |                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| ![Tool call](website/public/shots/ai-tool-call.png)<br>**Engine tool call** — name, arguments and return value, all laid open | ![Changes](website/public/shots/engine-changes.png)<br>**This round's changes** — what it touched in the engine                                   |
| ![Review](website/public/shots/engine-review.png)<br>**Review** — the verdict after the machine verified against the engine   | ![Self-check](website/public/shots/engine-selfcheck.png)<br>**Account for it** — answering each finding: what it missed, what it added on its own |

It ships with these too, each usable on its own:

|                                                                                              |                                                                             |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| ![Projects](website/public/shots/home-projects.png)<br>Project library: engines and projects | ![Assets](website/public/shots/asset-library.png)<br>Asset library          |
| ![Blueprints](website/public/shots/blueprint-library.png)<br>Blueprint gallery               | ![Materials](website/public/shots/material-library.png)<br>Material gallery |
| ![3D viewer](website/public/shots/model-viewer-wireframe.png)<br>3D viewer                   | ![Notebooks](website/public/shots/notebooks.png)<br>Notes and notebooks     |

---

## Install and go

Get an installer: [GitHub Releases](https://github.com/ueboxai/uebox/releases) · [website](https://uebox.ai)

Every local feature works the moment it opens. For AI, go to
**Preferences → AI → Model Sources**, add your own provider and bind a model to the
_Chat_ role — binding _Chat_ alone is enough to get the whole app running, other roles
fall back to it. The community edition talks to model vendors **directly**; there is no
gateway of ours in between.

The API key field accepts three forms:

| You type                         | What happens                                                   |
| -------------------------------- | -------------------------------------------------------------- |
| `sk-proj-...`                    | Stored encrypted via the OS secure storage                     |
| `OPENAI_API_KEY`                 | Read from the environment on every call, never written to disk |
| `!op read op://vault/openai/key` | Runs the command and uses its output                           |

Keys are never written into `models.json` and never read back into the UI.
Local inference (Ollama, LM Studio, llama.cpp) and self-hosted gateways
(LiteLLM, One API) are in the provider catalog too.

---

## ✨ Add features with AI (no coding required)

The stance of this project: **experiment freely while developing, concede
nothing at the acceptance gate.**

The repo ships a spec for AI agents to read ([AGENTS.md](AGENTS.md)) and a
one-command acceptance gate (`pnpm verify`). You just tell your AI assistant
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
runs** — the gate no longer touches the native module.

To produce an installer, cut a release, or get unstuck from the `better-sqlite3`
ABI, see [Packaging, releasing and the native module](docs/contributing/packaging.md).

---

## Documentation

| I am…                      | Start here                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A user who wants a feature | [Add a feature with AI](docs/contributing/vibe-coding.md) · [Request one](../../issues/new?template=feature_request.yml)                |
| A developer                | [Contributing](CONTRIBUTING.md) · [Vertical slice](docs/contributing/vertical-slice.md) · [Testing guide](docs/contributing/testing.md) |
| A release manager          | [Packaging and releasing](docs/contributing/packaging.md)                                                                               |
| An AI agent                | [AGENTS.md](AGENTS.md)                                                                                                                  |
| A designer                 | [UI design standards](docs/UI-Design-Standards.md)                                                                                      |

More topics live in [`docs/`](docs/).

Changelog: [CHANGELOG.md](CHANGELOG.md) ·
Security policy: [SECURITY.md](SECURITY.md) ·
Third-party components: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)

---

## License

[Apache License 2.0](LICENSE)
