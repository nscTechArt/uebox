# Module Map

This document maps the **product modules** of Unreal Box: which module owns a behavior,
which interfaces connect it to the rest of the app, and where its implementation and
evidence live. It is the responsibility view; `AGENTS.md` §4 owns the layer view (how one
feature crosses Model → IPC → Preload → API → Store → View), and `CONTEXT.md` owns the
vocabulary these names come from.

The code and observed behavior are the source of truth. When a fact here conflicts with
code, the code wins — fix this document in the same change that establishes the new
behavior. Planned work from `docs/` design documents is not a module until the code forms it.

Scope: `src/main/` plus the cross-process seams and the satellite artifacts
(`plugin/`, `resources/skills/`, `packages/cli`). The renderer mirrors these modules
through `src/renderer/src/views/` and `src/renderer/src/api/`; its per-feature slices are
self-evident by name and are not enumerated here.

## How to Read This Map

A **module** is a logical responsibility with an interface and an implementation — not a
directory, file, or IPC handler. Most modules span several directories, and several
modules share `src/main/services/`, `src/main/ipc/`, and `src/main/utils/`, which are
**role layers**, not module boundaries: `services/` is main-process service code, `ipc/`
is channel registration, `utils/` is shared helpers. Owning a behavior and hosting an
entry point are different things.

Edges between modules are **recorded, not prescribed**. The graph below describes real
code-level dependencies (imports and IPC), not a rule a change must satisfy. A direction
is stated as allowed or forbidden only where `AGENTS.md` already says so.

## Current Module Catalog

| Module | Primary responsibility | Owned capabilities |
|---|---|---|
| [Agent Runtime](#agent-runtime) | The product: session lifecycle, tool execution, model streaming | Agent loop, tools, runs, capabilities, experience, team sessions |
| [Persistence & Indexing](#persistence--indexing) | The two databases and their models, IPC, and query services | Public DB + per-vault DB, `db:*` channels, search/RAG query services |
| [Vault & Asset Library](#vault--asset-library) | The local Vault: asset files, index, import, thumbnails, tags | Asset import pipeline, folder/tag/note metadata, favorites, trash |
| [Package Libraries](#package-libraries) | Blueprint & Material libraries and the shared Library Browser | Library entries, snippets, package import/export, browser modules |
| [Remote & Collaboration](#remote--collaboration) | Network vaults, remote catalogs, and the app's own API surface | Vault sync, HTTP/WebSocket server, cloud adapters, team surfaces |
| [Notebook & Knowledge](#notebook--knowledge) | Notebooks, notes, source ingestion, and RAG over collected material | Sources (web/video/doc), notebook index, embedded notebook chat |
| [AI Access & Media](#ai-access--media) | Model/provider access, credentials, and media preparation | Provider catalog & auth, AIGC, object storage, speech/vision/video |
| [UE Integration](#ue-integration) | The bridge between the app and a running Unreal Editor | AgentLink plugin packaging, command bridge, editor health, UE file reads |
| [Projects & Engine Registry](#projects--engine-registry) | UE project registry, import, templates, and engine detection | Project import/archive, engine templates, naming rules, collections |
| [Tasks & Automation](#tasks--automation) | Queued background jobs with progress and retry | Task manager, import/package executors, task-to-video pipeline |
| [Platform & Shell](#platform--shell) | Windows, tray, settings, updates, and OS integration | Window managers, Spotlight/MiniChat, updater, app settings, security |

## State Ownership

Rule: **the file on disk is the user's truth; the databases are rebuildable indexes;
localStorage holds UI preferences only** (AGENTS.md §5 rule 10). Where each kind of state
actually lives:

| State | Truth | Index / copy |
|---|---|---|
| Vault assets (files + thumbnails) | The Vault directory on disk | `vault-data.db` inside the Vault — delete and rebuild |
| Asset index, FTS, vector index | `vault-data.db` (per current Vault) | Derived from vault files by the import/scan pipeline |
| App registry: projects, engines, settings, tags of record | Public app database | — |
| Agent transcripts | `.jsonl` per session + `.compaction.json` checkpoints on disk | — |
| Credentials, API keys, OAuth tokens | Main-process secure storage (`ai/credentials.ts`, `ai/oauth.ts`) | Never localStorage, never the databases |
| Media handed to a model | User's object storage, sent as a link | Base64/path fallback only per AGENTS.md §5 rule 13 |
| Vault sync state | Outbox/change-tracking rows in the databases | Server state reconciled by `networkV2` |
| UI prefs, one-shot flags | `localStorage` (baseline-ratcheted) | — |

## Module Entries

### Agent Runtime

**Responsibility.** Run the agent: session lifecycle, the agent loop, tool dispatch,
model streaming, budget, compaction, approvals, and everything the product exists for.

**Sub-areas.** `core/` — session loop, transcripts, `promptMedia` (the single media
decision point, AGENTS.md §5 rule 13), `requestBudget`, `streamFn`, resume/binding/scope,
write ledger, asset locks/snapshots/read-only guards; `tools/` — `defineTool` /
`defineUeTool`, `registry.ts`, `builtin/` (box, task, web, browser, local files/shell,
engines, notebook sources, MCP connect, tool search), `ue-*` and `adapted/` UE and
project tool families (plus the `app-control` family under the legacy top-level
`src/main/agent/tools/` dir); `host/` — run lifecycle (`activeRuns`, `runObserver`,
`runOwners`), renderer bridges (`eventBridge`, `approvalChannel`, `questionChannel`,
`steerQueue`); `capabilities/` — skills, MCP, plugins, user instructions; `experience/` —
the experience/learning loop (curator, recall, scheduler, store); `core/team/` —
multi-member team sessions, boards, model dossiers, track records; `vendor/pi-harness` —
vendored harness.

**Not responsible for.** Owning product data (Persistence owns the databases; the Vault
owns asset files), provider authentication (AI Access), or the UE wire protocol
(UE Integration) — tools consume those seams.

**Interface.** `ipc/agentV3.ts` channel family; `ipc/attachment.ts` +
`services/attachmentIngest.ts` (normalize any dropped file into model-consumable input
before the prompt path); tool definitions and receipts (receipt semantics per AGENTS.md
§5 rule 14); session/run events over `host/` channels; skills and MCP servers loaded at
runtime.

**Ownership & lifetime.** A session is run-scoped; transcripts persist as files.
Settings-sensitive reads go through `appSettingsManager` — mind the trap in AGENTS.md §7.

**Depends on.** `services/*` and `sqliteDataBase/*` — tool implementations are the call
sites. Hosted inbound by Remote & Collaboration (`services/http`, `services/websocket`
serve agent runs to external clients).

**Implementation.** `src/main/agent-v3/`. **Evidence.** Per-area `*.test.ts` beside
source (`promptMedia.test.ts`, `requestBudget.test.ts`, `team/team.integration.test.ts`,
…); `docs/Agent自然进化设计-2026-09-30.md` for experience.

### Persistence & Indexing

**Responsibility.** Own both databases — the public app DB and the per-Vault
`vault-data.db` — their schemas, models, `db:*` IPC, query services, and workers.

**Not responsible for.** The truth of what it indexes: vault files, `.uproject` files,
and transcripts are owned by their modules. The DB is a rebuildable index, never the
single source for user-authored data.

**Interface.** `sqliteDataBase/ipc/` handler files → `window.api.database.*` (chat
persistence included: `chatHistory.ts`, `chatSessionFiles.ts`); model DDL in `models/`;
`DatabaseManager` (public DB + current-vault routing via `VaultManager`), `services/`
query runners, `workers/assetQueryWorker`, `sqliteVec`.

**Depends on.** better-sqlite3; vault paths from Vault & Asset Library. Consumed by
nearly every module — that is its job.

**Implementation.** `src/main/sqliteDataBase/`, `services/backup/` (database backup).
**Evidence.** `vaultSchema.test.ts`, `vaultConnectionPragmas.test.ts`,
`models/index.test.ts`, per-model `*.test.ts`.

### Vault & Asset Library

**Responsibility.** The local Vault: a directory of asset files plus its index — import,
metadata, thumbnails, tags, folders, notes, favorites, trash.

**Not responsible for.** Remote/network vaults (Remote & Collaboration), blueprint /
material package libraries (Package Libraries), or notebook knowledge.

**Interface.** `db:asset*`/`db:tag*`/`db:folder*`/vault channels; `services/asset/`
import pipeline (`AssetImportService`, `RemoteImportService`, `ResumeImportService`,
`autoTagService`, `importControl`); `utils/` thumbnail and asset-name helpers;
`views/AssetManagement/` renderer slice.

**Ownership & lifetime.** The Vault directory is the truth and survives the DB; a vault
is switchable (`VaultManager.switchToVault`). Index content is disposable.

**Depends on.** Persistence & Indexing for the index; Remote & Collaboration when the
vault is network-synced; AI Access for auto-tagging/analysis.

**Implementation.** `sqliteDataBase/models/asset*`, `tag*`, `folderTag*`,
`assetFavorite.ts`; `sqliteDataBase/ipc/asset*`, `vault.ts`, `dragMove.ts`;
`services/asset/`, `services/favoriteService.ts`; `utils/ThumbnailManager.ts`,
`assetDependency/`, `assetBackup/`.

### Package Libraries

**Responsibility.** The blueprint and material libraries and the shared Library Browser
with its pluggable modules (CONTEXT.md「模块 / DLC」).

**Not responsible for.** Vault asset indexing, or the remote catalog protocol itself —
`libraryV3/` (remote catalog client) sits in Remote & Collaboration; this module consumes
its entries.

**Interface.** `services/library/` (`libraryEntryStore`, `snippetScan`,
`pluginCapabilities`), `libraryPackageStore`, `ipc/libraryPackage.ts`,
`ipc/catalogLibrary.ts`, `blueprint-layout/` (graph layout for blueprint display),
`models/libraryStore.ts`; `views/BlueprintLibrary/`, `MaterialLibrary/`,
`library-common/browser/`.

**Depends on.** Persistence & Indexing; Remote & Collaboration for shared/network
libraries; UE Integration when a package round-trips through the editor.

### Remote & Collaboration

**Responsibility.** Everything that leaves the machine: network vault sync, remote
library catalogs, cloud drives, and the app's own HTTP/WebSocket API that hosts agent
runs and DB access for external clients (including `packages/cli`).

**Not responsible for.** Deciding what the agent does — `services/http` and
`services/websocket` are transport; they *host* Agent Runtime, they do not contain it.
The direction is real: transport → agent, agent tools → services.

**Interface.** `networkV2/` (`SyncClient`, `AssetServer`, `NetworkSyncBridge`,
`SyncProtocol`, vault access keys), `smb/` (SMB network auth + vault sync),
`libraryV3/` (remote catalog session, TLS trust, secrets, page cache),
`services/http/server.ts`, `services/websocket/`, `services/messaging/` router +
handlers, `ipc/networkVault*.ts`, `baiduyun.ts`, `webdav.ts`, `teamEditorWatch.ts`,
`teamSnapshots.ts`.

**Depends on.** Agent Runtime (hosted), Persistence & Indexing, UE command bridge.
External calls are user-configured only — never add official-server calls
(`verify:official-endpoints` gate).

**Evidence.** `networkV2/*.test.ts` (SyncClient reconcile/upgrade suites),
`libraryV3/session.test.ts`, `services/websocket/server.test.ts`.

### Notebook & Knowledge

**Responsibility.** Notebooks: collecting sources (web pages, videos, documents), notes,
indexing and RAG over them, and the notebook-embedded chat.

**Interface.** `models/notebook*`, `note.ts`, `notebookRag*`; `ipc/notebook*.ts`,
`webRead.ts`, `bilibili.ts`, `youtube.ts`, `wechat.ts`; `services/` —
`documentLoader`, `webReader`, `notebookImageReader`; `sqliteDataBase/services/
notebookRagService`, `notebookIndexJobService`, `notebookChatV2Service`;
`views/Notebook/`, `NoteEditor.vue`.

**Not responsible for.** The embedded chat's session machinery (an Agent Runtime run),
general web search (AI Access), or vault asset indexing.

**Depends on.** Persistence & Indexing; AI Access for embeddings, RAG, and the embedded
chat; Agent Runtime drives `notebookChatV2` sessions.

### AI Access & Media

**Responsibility.** Model/provider access and everything between user media and the
model: provider catalog and auth, AIGC generation, object storage, speech, vision,
video/audio analysis, external search providers.

**Not responsible for.** The media *decision* — `promptMedia` in Agent Runtime decides
object-storage-link vs fallback (rule 13); this module only performs uploads and
provider calls.

**Interface.** `src/main/ai/` (provider `catalog`, `credentials`, `oauth`, `embedding`,
`imageGeneration`, `music`, `model3d`, `judge`, `vision`, `messageConverter`);
`services/` — `dashscope`, `aigc`, `objectStorage` (S3 client), `localImageGeneration`,
`configuredImageAnalysis`, `imagePollingService`, `videoAnalysis`, `videoCompressor`,
`searxngSearch`, `webSearch`, `browserSearch`, `searchProvider`/`searchRelevance`;
`ipc/ai*.ts`, `aigc.ts`, `dashscope.ts`, `vision.ts`, `speech*.ts`, `realtimeVoice.ts`,
`voiceCallPresence.ts`, `objectStorage.ts`.

**Depends on.** Persistence (settings), object storage config from Platform settings.
Agent Runtime consumes it through session model + media paths.

### UE Integration

**Responsibility.** The bridge to a running Unreal Editor: the AgentLink plugin, the UE
command bridge, editor health/crash watch, engine path detection, and encoding-safe reads
of engine-authored files.

**Interface.** `plugin/UnrealAgentLink/` (packaged plugin — see
`docs/contributing/packaging.md`), `ipc/ueCommandBridge.ts`, `unrealPath.ts`,
`unrealProcess.ts`, `epicProjects.ts`, `editorHealth.ts`;
`utils/UnrealPathManager`, `UnrealProcessDetector`, `ueTextFile` (mandatory for
`.uproject`/`.uplugin` — rule 12), `uePackagePath`, `uasset-reader-new.js`;
`services/editorHealth.ts`, `services/editorCrashWatch/`; the `ue-*` tool families in
Agent Runtime consume the bridge.

**Not responsible for.** The project/engine registry records (Projects & Engine
Registry) or which agent tools choose to call the bridge.

**Depends on.** The UE editor process and plugin socket protocol; Agent Runtime tools
are the call sites.

### Projects & Engine Registry

**Responsibility.** The registry of UE projects and engines: import (folder, archive,
network vault), templates, engine version detection, collections, naming rules.

**Interface.** `models/project*`, `projectCollection`, `customEngine`;
`services/project/` (`openUproject`, `autoRegister`, `archiveImport`, `engineTemplates`,
`httpVaultDownload`, `importSettlement`, `packageCopyQueue`); `ipc/projectImport*.ts`,
`projectEngineVersion.ts`, `projectTemplate.ts`, `namingRules.ts`,
`epicProjects.ts`; `utils/namingRulesConfig`, `projectPath`; `views/` project surfaces.

**Not responsible for.** Talking to a running editor (UE Integration owns the bridge;
this module only detects installs and reads project files) or executing imports inside
the queue machinery (Tasks & Automation runs them).

**Depends on.** Persistence & Indexing; UE Integration for version detection and
`.uproject` reads; Remote & Collaboration for vault-sourced imports.

### Tasks & Automation

**Responsibility.** Queued background work with progress, retry, and reporting: the task
manager, import/package executors, and the task-to-video render pipeline.

**Interface.** `services/task/` (`taskManager` + `executors/`), `services/taskVideo/`
(audio, composition, render, schema), `models/importTask.ts`, `importRecoveryContext`;
agent tools `task`, `taskVideo`; used by Projects (imports), AIGC (video jobs), and the
HTTP API for remote job submission.

**Not responsible for.** The semantics of what a job produces — artifact contracts
belong to the queueing module; this module owns queue, progress, retry, and lifecycle.

**Depends on.** Persistence for job records; whichever module queued the job.

### Platform & Shell

**Responsibility.** The desktop shell itself: windows, tray, Spotlight, MiniChat,
settings, updates, security/network policy, i18n, logging, startup, OS integration.

**Interface.** `appWindows.ts`, `mainWindow*`, `chatWindow*`, `miniChatManager`,
`spotlightManager`, `tray/`, `trayIcon`, `dockIcon`, `windowStateManager`,
`singleInstanceLock`, `startupQuiet`/`startupVisibility`, `appSettingsManager`,
`security.ts`, `networkPolicy.ts`, `i18n.ts`, `electronLog`/`logger`, `services/updater/`
(feed resolution per AGENTS.md §3), `mediaPermissions`, `shortcutService`,
`services/system/`, `services/cache/`; `ipc/` — `appSettings`, `updater`, `window`,
`dialog`, `shell`, `contextMenu`, `path`, `dragDrop`, `nativeFileDrag`, `fileIPC`,
`spotlight`, `diagnostics`, `screenRecorder`; `init/` (startup wiring),
`services/monitoring/` (health and memory metrics), `services/cli/` (install state and
PATH toggle for the packaged `uebox` CLI — the CLI itself is a satellite).

**Depends on.** Nothing product-level; every module depends on it.

**Not responsible for.** Feature semantics — it owns shells and policy, not libraries,
chats, or agents.

## Satellite Artifacts

These ship or load separately but are part of the product surface:

| Artifact | Role |
|---|---|
| `plugin/UnrealAgentLink/` | UE editor plugin; packaged per engine version (gate `verify:plugin`) |
| `resources/skills/` | Runtime skills loaded by the in-app agent (standard: `SKILL_STANDARD.md`, gate `verify:skills`) |
| `packages/cli/` | `uebox` CLI — external client of the Remote & Collaboration API surface |

## Maintenance Rules

Update this document in the same change when:

- a module gains, loses, or hands off a responsibility;
- a cross-module interface (channel family, tool seam, service contract) changes;
- where a kind of state lives changes (disk / public DB / vault DB / secure storage /
  localStorage / object storage);
- a real dependency between modules is introduced, removed, or reverses direction;
- a subsystem directory moves or splits.

An implementation-only change inside one module does not require an edit. List only
modules the code has already formed. Recorded edges describe the code as it is;
allowed/forbidden rules live in `AGENTS.md`.
