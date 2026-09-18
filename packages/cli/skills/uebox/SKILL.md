---
name: uebox
description: Drive Unreal Box and a running Unreal Engine editor from the terminal through the `uebox` CLI — check the connection, pick the target project, read selection and actors, save viewport screenshots, spawn/move/delete actors, search the box's asset library, import library assets into a project, and organise the project library. Use when the task needs the live state of an open UE editor or the box's own libraries, and `uebox --version` succeeds. Do not use for reading .uproject or asset files off disk, or when no Unreal Box is running — read the files directly instead.
---

# Driving Unreal Engine with `uebox`

`uebox` is a terminal client for Unreal Box. It talks to the running box over a local
loopback connection, and the box talks to the open Unreal Editor. Every command is one
process: it connects, does one thing, prints, exits.

**Read-only unless you pass `--allow-write`.** With that flag you can call anything the
box's own assistant can call — including asset-library search, importing library assets
into a project, and project-library organisation. Without it, every write exits 6.
The flag is the user's consent: the CLI has no approval dialog, so do not add it unless
the user asked for a change.

## Start here

Run `uebox doctor` once at the beginning of a session, and again after any connection
error. **Do not run it before every command** — it is a five-layer check, not a ping.

```
uebox doctor --json
```

It reports five layers in order: config, auth, contract, tool scope, project registration.
Whichever layer fails carries its own remedy in `error.hint`. Follow that hint rather than
guessing; "cannot connect" and "no editor connected" need completely different next steps.

## Always read the exit code

Every command exits non-zero on failure, and the code says which kind:

| Code | Meaning | What to do |
|---|---|---|
| 0 | Done. An empty result is still success | Continue |
| 2 | Bad argument or output location | Fix the command |
| 3 | Config or auth | Read `error.code` before acting — see below |
| 4 | Box unreachable or too old | Tell the user to start/upgrade Unreal Box |
| 5 | No single target project | Run `uebox projects list`, then pass `--project` |
| 6 | Tool out of scope for this version | Stop; do not look for a way around it |
| 7 | Timeout | **Verify the real state first**; do not resend |
| 8 | Engine operation failed, or the file was not delivered | Read the message |
| 130 | Interrupted — the engine did **not** roll anything back | Verify the real state |

With `--json`, stdout is exactly one JSON object, on success and on failure alike.
Parse `ok`, then `data` or `error`. Diagnostics go to stderr and never pollute stdout.

Exit code 3 covers four different situations, and they need different fixes — read
`error.code`, not just the exit code:

- `CONFIG_MISSING` — never set up. Run `uebox setup`.
- `CONFIG_UNREADABLE` — **the file is there, you just cannot read it.** Do not
  reinstall and do not re-run setup; neither will help. In a sandbox, add that path
  to your readable set, or use the `UEBOX_URL` / `UEBOX_TOKEN` environment variables.
- `CONFIG_INVALID` — the file is corrupt. `error.message` says how.
- `AUTH_FAILED` — the token was rejected. Run `uebox setup` again.

## Name the project whenever more than one is open

The target is decided in three steps: an explicit `--project`, else the nearest
`.uproject` walking up from the current directory, else — only when exactly one project is
online — that one.

**A project named explicitly is never swapped for a different one.** If it is not
connected the command fails with exit 5. That is deliberate: silently retargeting would
edit the wrong level. When `uebox projects list` shows more than one project, pass
`--project` on every command.

## The three high-frequency commands

```
uebox selection get --json
uebox actors list --name Cube --json
uebox viewport screenshot --output ./artifacts/viewport.png --json
```

- **`selection get`** answers "what does the user mean by *this*". Reach for it before
  asking the user which object they meant.
- **`actors list`** returns `returnedCount`, `totalCount` and `truncated` together.
  **Never report `returnedCount` as the total.** A `null` `totalCount` means the plugin did
  not report one — that is "unknown", not "no more". Raise `--limit` (max 1000) or narrow
  with `--name`.
- **`viewport screenshot`** writes the file and verifies it before reporting success.
  Read the saved file from `artifacts[0].path`; never expect image bytes on stdout.

Details that decide whether a screenshot means anything: `references/screenshots.md`.

## `null` means unknown, not zero

Older UnrealAgentLink plugins do not report some fields. Those come back as `null`, and
the command adds a warning saying so. Treat `null` as "this plugin version does not say" —
reading it as `0` turns "I don't know" into a confident wrong answer.

## Everything else goes through `tools`

```
uebox tools list --search blueprint --json
uebox tools show ue_get_actor --json
uebox tools call ue_get_actor --args-file ./query.json --project "D:/Games/Demo" --json
```

`tools list` shows the read-only tools by default; add `--allow-write` to see the ones that
change things. `tools show` never needs the flag — call it before `tools call`, because it
returns the real input schema. Do not invent example arguments from a tool's name.

Anything the box's own assistant can do is here, not just engine commands: the asset
library (`search_assets`), the project library (`project_list`, `project_organize`),
and library-to-project import (`project_manage`).

### Finding an asset and importing it

This is the common one — the box's library is where the user's assets live, and the
project only has what has already been imported.

```bash
uebox tools call search_assets --args-file ./query.json --json
uebox tools call project_manage --args-file ./import.json --allow-write --json
uebox tools call ue_content_search --args-file ./check.json --json
```

`search_assets` returns `assetKey` values; `project_manage` takes them (or a whole
`folder`) plus a `projectKey` from `project_list`. Read each tool's schema with
`tools show` rather than guessing the field names — they are not the CLI's own flags.

A `.uasset` import does not need the editor open; external files (FBX, PNG, OBJ) do.
Import replies have no `verified` field, so confirm with `ue_content_search` before
telling the user it landed.

For anything with nested structure, write a UTF-8 JSON file and pass `--args-file`; this
sidesteps quoting differences between PowerShell, cmd and bash. `--args-file -` reads
stdin. The CLI checks only that the JSON parses to an object; types and required fields
are validated by the box.

## Writing actors: the reinforced path

```bash
uebox actors spawn  --name Box1 --asset StaticMeshActor --location 0,0,50 --allow-write --json
uebox actors move   --name Box1 --location z=200 --allow-write --json
uebox actors delete --name Box1 --allow-write --json
```

`--location` takes either `x,y,z` or a single named component (`z=200`, leaving x/y alone).
`--rotation` is degrees, `--scale` is multipliers. Locations are centimetres — see the
units note in the read commands above; do not convert.

Four things to know before you use these:

- **`--allow-write` is required on every write.** Leaving it off gives exit code 6. It is
  not a formality — the CLI has no approval dialog, so this flag is the user's consent.
  If the user has not asked for a change, do not add it.
- **Success already means verified — on these four commands only.** They read the engine
  back and compare before reporting success, so exit 0 means the engine's current state
  matches what you asked for, and the reply carries a `verified` field. A write made
  through `tools call` has no `verified` field: there, judge by what the tool itself
  reported.
- **Exit 8 means it did not take effect**, even though the tool itself reported no error.
  Trust the read-back, not the tool. Report it; do not retry blindly.
- **Only absolute values.** There is no relative move. To nudge something, read its current
  transform with `actors list --name ...`, add your delta yourself, and set the result.

To undo: `uebox actors undo --allow-write`. It undoes one step and verifies by reading the
undo stack before and after.

**Never tell the user to press Ctrl+Z to undo your change.** CLI writes land on a separate
agent undo stack; the editor swaps its own stack back when the transaction ends. Ctrl+Z
therefore undoes *the user's* last manual action and leaves your change in place — worse
than doing nothing.

Two things to pass on after an undo: it only changes what is in memory, so the affected
packages must be saved in the editor to reach disk; and that stack is shared with the agent
running inside the box, so if anything else wrote in between, the step you undo may not be
yours. `uebox tools call ue_undo_history` is read-only and shows the stack.

Anything not covered by these four commands goes through `tools call --allow-write`
(next section).

## After a timeout, verify — do not resend

Exit code 7 means the request was sent and the outcome is unknown. Resending can perform
an already-successful operation twice. Query the current state first (`selection get`,
`actors list`) and decide from what you see.

Calls that legitimately take minutes — waiting for an editor restart, for instance — need
an explicit larger `--timeout`; the default is 120 seconds.

## Exit 6: missing consent, or genuinely out of scope

Two different situations share this code, and the message says which:

- **"this command has not enabled writes"** — the tool is callable, you just did not pass
  `--allow-write`. Add it only if the user asked for the change.
- **"out of scope"** — either the tool demands per-call human approval, or the box did not
  declare what it is. Report that plainly and stop.

If a write tool is missing from `tools list --allow-write` entirely, the box's MCP settings
probably do not have "also expose mutating tools" turned on. `uebox doctor` says so; that
is the user's switch to flip, not something to route around.

Never route around the CLI by writing Python, editing files under the project directory, or
driving the editor another way. The limits that remain are deliberate, and working around
them removes the user's ability to approve what happens to their project.
