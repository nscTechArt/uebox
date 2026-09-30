---
name: uebox
description: Drive Unreal Box and a running Unreal Engine editor from the terminal through the `uebox` CLI — check the connection, pick the target project, call any of the box's tools (read selection and actors, move/spawn/delete actors, search the asset library, import library assets into a project), save viewport screenshots, or hand a whole task to the box's own agent with `uebox ask`. Use when the task needs the live state of an open UE editor or the box's own libraries, and `uebox --version` succeeds. Do not use for reading .uproject or asset files off disk, or when no Unreal Box is running — read the files directly instead.
---

# Driving Unreal Engine with `uebox`

`uebox` is a terminal client for Unreal Box. It talks to the running box over a local
loopback connection, and the box talks to the open Unreal Editor. Every command is one
process: it connects, does one thing, prints, exits. There is nothing to set up — it finds
the box's config on its own.

**Read-only unless you pass `--allow-write`.** With that flag you can call anything the
box's own assistant can call — including asset-library search, importing library assets
into a project, and project-library organisation. Without it, every write exits 6.
The flag is the user's consent: the CLI has no approval dialog, so do not add it unless
the user asked for a change.

## Start here

Run `uebox doctor` once at the beginning of a session, and again after any connection
error. **Do not run it before every command** — it is a layered check, not a ping.

```
uebox doctor --json
```

It reports the layers in order: connection (config and auth), contract, tool scope,
project registration. Whichever layer fails carries its own remedy in `error.hint`. Follow
that hint rather than guessing; "cannot connect" and "no editor connected" need completely
different next steps.

## Always read the exit code

Every command exits non-zero on failure, and the code says which kind:

| Code | Meaning | What to do |
|---|---|---|
| 0 | Done. An empty result is still success | Continue |
| 2 | Bad argument or output location | Fix the command |
| 3 | Config or auth | Read `error.code` before acting — see below |
| 4 | Box unreachable or too old | Tell the user to start/upgrade Unreal Box |
| 5 | No single target project | Run `uebox projects list`, then pass `--project` |
| 6 | Missing `--allow-write`, or tool out of scope | See "Exit 6" below |
| 7 | Timeout | **Verify the real state first**; do not resend |
| 8 | Engine operation failed, or the file was not delivered | Read the message |
| 130 | Interrupted — the engine did **not** roll anything back | Verify the real state |

With `--json`, stdout is exactly one JSON object, on success and on failure alike.
Parse `ok`, then `data` or `error`. Diagnostics go to stderr and never pollute stdout.

Exit code 3 covers four different situations, and they need different fixes — read
`error.code`, not just the exit code:

- `CONFIG_MISSING` — no box config found. Unreal Box has never been started on this
  machine, or it is installed somewhere unusual: pass `--config <path>` or set
  `UEBOX_HOST_CONFIG`.
- `CONFIG_UNREADABLE` — **the file is there, you just cannot read it.** Do not reinstall;
  it will not help. In a sandbox, add that path to your readable set, or use the
  `UEBOX_URL` / `UEBOX_TOKEN` environment variables.
- `CONFIG_INVALID` — the file is corrupt, or two boxes are installed and the CLI will not
  guess which. `error.message` says which; the hint says how to pick.
- `AUTH_FAILED` — the token was rejected. If you set `UEBOX_TOKEN`, it is stale; otherwise
  `uebox doctor` shows which config was read.

## Name the project whenever more than one is open

The target is decided in three steps: an explicit `--project`, else the nearest
`.uproject` walking up from the current directory, else — only when exactly one project is
online — that one.

**A project named explicitly is never swapped for a different one.** If it is not
connected the command fails with exit 5. That is deliberate: silently retargeting would
edit the wrong level. When `uebox projects list` shows more than one project, pass
`--project` on every command.

## Two ways in: one tool, or the whole agent

- **`uebox tools call <tool>`** — you decide which tool and what arguments. Use this when
  you know the step.
- **`uebox ask "<task>"`** — the box's own agent works out the steps and reports back.
  Use this for a multi-step job you would otherwise script tool by tool.

### Calling tools

```
uebox tools list --search actor --json
uebox tools show ue_get_actor --json
uebox tools call ue_get_selection --json
uebox tools call ue_get_actor --args-file ./query.json --project "D:/Games/Demo" --json
```

`tools list` shows the read-only tools by default; add `--allow-write` to see the ones that
change things. `tools show` never needs the flag — call it before `tools call`, because it
returns the real input schema. Do not invent arguments from a tool's name.

Three tools answer most questions about the editor:

- **`ue_get_selection`** answers "what does the user mean by *this*". Reach for it before
  asking the user which object they meant.
- **`ue_get_actor`** reads actors and their transforms. Locations are centimetres,
  rotations degrees, scale multipliers — do not convert.
- **`uebox viewport screenshot --output <file.png>`** writes the file and verifies it before
  reporting success. Read the saved file from `artifacts[0].path`; never expect image bytes
  on stdout. Details that decide whether a screenshot means anything:
  `references/screenshots.md`.

For anything with nested structure, write a UTF-8 JSON file and pass `--args-file`; this
sidesteps quoting differences between PowerShell, cmd and bash. `--args-file -` reads
stdin. The CLI checks only that the JSON parses to an object; types and required fields
are validated by the box.

### Finding an asset and importing it

The box's library is where the user's assets live; the project only has what has already
been imported.

```bash
uebox tools call search_assets --args-file ./query.json --json
uebox tools call project_manage --args-file ./import.json --allow-write --json
uebox tools call ue_content_search --args-file ./check.json --json
```

`search_assets` returns `assetKey` values; `project_manage` takes them (or a whole
`folder`) plus a `projectKey` from `project_list`. Read each tool's schema with
`tools show` rather than guessing the field names.

A `.uasset` import does not need the editor open; external files (FBX, PNG, OBJ) do.
Confirm with `ue_content_search` before telling the user it landed.

### Handing a task to the box's agent

```
uebox ask "list every point light in the level with its intensity" --json
uebox ask "halve the intensity of every point light" --allow-write --json
```

- **Read-only by default.** Without `--allow-write` the agent's write tools are removed,
  not just discouraged — it can look but not change.
- **Its reach is fixed:** engine, asset library, project library. It never gets the shell,
  local files, the browser or third-party MCP servers, with or without the flag.
- **It runs on the model configured in the box**, billed to that model. Do not use it for
  a single lookup that one `tools call` would answer.
- Progress lines go to stderr while it works; the conclusion is `data.answer`, and ends
  with a line listing every write it made. **Report that line to the user** — it is
  bookkeeping, not the agent's own claim.
- For `ask`, `--timeout` is how long it may go without any progress, not total time.

`uebox tools call task` is refused on purpose — use `ask`, which applies the limits above.

## Changing things

Writes go through `tools call --allow-write` (or `ask --allow-write`). Before you use it:

- **`--allow-write` is required on every write.** Leaving it off gives exit code 6. It is
  not a formality — the CLI has no approval dialog, so this flag is the user's consent.
- **Judge by what the tool reported.** Box tools read the engine back before reporting
  success; read their reply, not your request. `ue_spawn_actor` tells you when a name was
  taken and it used `Name_1` instead — use the name it reports from then on.
- **Relative moves are not idempotent.** `ue_set_transform` with `add`/`multiply` moves
  twice if resent. After a timeout, read the transform with `ue_get_actor` before deciding.

To undo: `uebox tools call ue_undo --allow-write`. `ue_undo_history` (read-only) shows the
stack first.

**Never tell the user to press Ctrl+Z to undo your change.** CLI writes land on a separate
agent undo stack; the editor swaps its own stack back when the transaction ends. Ctrl+Z
therefore undoes *the user's* last manual action and leaves your change in place — worse
than doing nothing.

Two things to pass on after an undo: it only changes what is in memory, so the affected
packages must be saved in the editor to reach disk; and that stack is shared with the agent
running inside the box, so if anything else wrote in between, the step you undo may not be
yours.

## `null` means unknown, not zero

Older UnrealAgentLink plugins do not report some fields. Those come back as `null`.
Treat `null` as "this plugin version does not say" — reading it as `0` turns "I don't know"
into a confident wrong answer.

## After a timeout, verify — do not resend

Exit code 7 means the request was sent and the outcome is unknown. Resending can perform
an already-successful operation twice. Query the current state first (`ue_get_selection`,
`ue_get_actor`, `ue_content_search`) and decide from what you see.

Calls that legitimately take minutes — waiting for an editor restart, for instance — need
an explicit larger `--timeout`; the default is 120 seconds.

## Exit 6: missing consent, or genuinely out of scope

Two different situations share this code, and the message says which:

- **"this command has not enabled writes"** — the tool is callable, you just did not pass
  `--allow-write`. Add it only if the user asked for the change.
- **"out of scope"** — the tool demands per-call human approval, the box did not declare
  what it is, or it is `task` (use `ask`). Report that plainly and stop.

If a write tool is missing from `tools list --allow-write` entirely, the box's MCP settings
probably do not have "also expose mutating tools" turned on. `uebox doctor` says so; that
is the user's switch to flip, not something to route around.

Never route around the CLI by writing Python, editing files under the project directory, or
driving the editor another way. The limits that remain are deliberate, and working around
them removes the user's ability to approve what happens to their project.
