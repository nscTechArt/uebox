---
name: ue-system-diagnostics
description: Run console commands and Python inside the editor, read performance numbers, check crash reports, inspect the local ZenServer cache, and enable or disable plugins. Use when the task needs something the dedicated tools cannot express, or when the user asks about performance, crashes, shader recompiles, cache disk usage or plugins. Do not use for ordinary asset, actor or Blueprint work — those have their own tools.
---

# System, Python and diagnostics

Verified against UE 5.5.4 with UnrealAgentLink. These are the highest-privilege tools in the set:
six tools, of which three — `ue_run_console_command`, `ue_run_python_script` and
`ue_manage_plugin` — are marked irreversible and will ask the user for approval.

## Python is the escape hatch — and it returns output now

`ue_run_python_script` runs inside the editor with the full `unreal` module. Anything the
dedicated tools cannot do, this can — reading and writing alike.

It returns whatever the script prints:

```python
import unreal
ar = unreal.AssetRegistryHelpers.get_asset_registry()
print("count:", len(ar.get_assets_by_path('/Game', recursive=True)))
```
→ `stdout: count: 42`

Use `print()` for anything you want to read back. For structured data you also need to act on,
assign `output_data`:

```python
output_data = {"total": 42, "sample": ["/Game/A", "/Game/B"]}
```

Errors come back with the real Python message (`name 'foo' is not defined`), so read it and fix
the script rather than re-running it unchanged. Output is truncated to the last 8000 characters —
aggregate inside the script instead of printing a row per asset.

It prompts for approval every time, because a Python script can do anything. Say what the
script will do before calling — "count the static meshes over 100k triangles" is reviewable,
"run a diagnostic script" is not.

A script that changes things in bulk runs twice: first a read-only pass that prints what it
would change and how many, then the real one; afterwards read the changed values back. Do not
delete, rename or move assets from Python — `ue_content_delete` and `ue_content_move` check
who references them first, and a script skips that.

### "Can do anything" is about capability, not permission

Approval is the last gate, not the first. If a dedicated tool exists, use it. Do not reach for
Python to quietly do something another skill advises against by default — `ue-sequencer`, for
example, leaves a user's existing sequence alone unless they agree to the specific change.

Skills describe defaults, not vetoes over the user. When the user explicitly asks for something
a skill advises against, state the concrete risk once, get a clear yes, then write the script.
The approval prompt alone is not that yes: describe what the script will change before calling.

## Console commands return their output

`ue_run_console_command` now reports what the command printed:

```
r.ScreenPercentage  →  r.ScreenPercentage = "100"   LastSetBy: Scalability
```

Commands that only toggle an on-screen overlay (`stat unit`, `stat fps`) produce no text, and the
result says so — that is normal, not a failure. Some commands only write to the output log: that
is the file `Saved/Logs/<Project>.log`, searched with `grep_local_files`. It is **not** the
Message Log — `ue_message_log` reads the editor's Message Log window (Blueprint compile errors,
map check, PIE runtime errors), where console output never appears.

While PIE is running it runs against the **game world**; otherwise against the editor world.
Cvars (`r.*`, `ShowFlag.*`) are global, so that only matters for commands that read or act on a
world — `dumpticks`, object queries: PIE duplicates the level, so the two are different actors.
To inspect the game, run the command while PIE is up; to inspect the level asset, run it after
PIE ends. An older plugin always used the editor world — if results look like the unplayed
level, that is why.

A cvar you set stays set for the whole editor session, PIE included, until you change it back. To
check a change took, query the cvar by name with no value. Before finishing, call
`ue_run_console_command({ restore_all: true })`: it puts back the numeric `r.*`, `ShowFlag.*`,
`sg.*` (and a few similar) values this tool set; anything else you set, set back yourself.
Prefer a cvar over `ue_set_config` for trying something out: the cvar is gone on restart, the
config write goes into the project.

## Performance numbers need their context stated

`ue_get_performance_stats` samples the editor **as it is right now**. An editor window in the
background throttles itself hard — real measurement: 4.8 FPS with render thread and GPU both at
zero, which is not a performance problem, it is an editor that is not drawing anything.

The tool flags this case. When it does, do not report a frame-rate problem: ask the user to bring
the editor forward and enter PIE, then sample again. Even a clean sample is the editor, not a
packaged build — say so when you report numbers.

## Crashes: check the count, not the presence of a report

`ue_get_crash_logs` falls back to the tail of the current run's log when there are no crash
reports. Read `crash_report_count`:

- `0` → nothing crashed. The attached log lines are context only. Do not tell the user their
  project crashed.
- `> 0` → real crashes from `Saved/Crashes`. Ensures, stalls and killed processes are written to
  the same folder while the editor stays alive; the tool lists those under `non_fatal` and does
  not count them. Mention them if relevant, never analyse them as a crash.

`crash_type` is the engine's own label. `GPUCrash` comes with a `note`: the call stack only shows
where the CPU submitted work, so do not explain the crash from it — follow the note.

### Reading a crash

1. **Type, from the first line.** `EXCEPTION_ACCESS_VIOLATION reading address 0x0000000000000000`
   or a small address such as `0x0000000000000010` is a null pointer (the small number is a member
   offset). A garbage-looking address points at freed memory — a common cause is a `UObject*`
   member without `UPROPERTY()`, which garbage collection does not see. `Assertion failed:` is a
   `check()`; the expression and the file and line after it say what was violated.
   `EXCEPTION_STACK_OVERFLOW` is runaway recursion — look for frames that repeat.
2. **First frame that is the project's own code.** Walk down the call stack past engine frames to
   the first one in a project module (`cpp_list_modules` lists them) or under the project's
   `Source/`. That is usually where the fix goes; read that file and line with `read_local_file`.
3. **No symbols, no guessing.** `frames.unresolved` equal to `frames.total` (every frame is
   `UnknownFunction`) means the debug symbols are missing. Do not infer the cause from a DLL name. Locally built project modules have
   symbols; for engine frames on a launcher install the user has to add the "Editor symbols for
   debugging" option to the engine.
4. **The cause is often before the crash** — an asset that failed to load a few seconds earlier, a
   warning about a missing reference. Each report's `logSnippet` is the tail of the log copy
   inside the crash folder (`log_file`), i.e. the session that crashed; read further back in that
   file when the tail is not enough. `Saved/Logs/<Project>.log` is the new session once the editor
   has restarted and says nothing about the crash.

### Fixing it

Reproduce → narrow → fix → reproduce.

- **Reproduce first.** Find steps that trigger it: `ue_playtest` (with `events`, `stop_on_error`),
  `ue_autoplay`, or the user's own steps. If you cannot make it happen, any fix is unverified —
  say so.
- **Narrow.** Put several log points on the suspected path in one go and run once, rather than one
  per run.
- **Fix the cause.** A null check at the crash site without knowing why the pointer is null only
  moves the bug somewhere quieter.
- **Run the same steps again.** The error lines from before must be gone. That is the proof — a
  clean compile is not.

## Local cache: ask ZenServer, not the file system

`ue_zen_server` reads the local ZenServer (the engine's derived-data cache service, default
`127.0.0.1:8558`) over its own HTTP interface: hit ratio, cache and CAS disk usage, and which
projects it holds data for. Read-only; it never cleans anything.

Reach for it when the user says the editor keeps compiling shaders, loading is slow, or the
system drive is filling up. Three things to say with the numbers:

- Hits and misses count **since ZenServer last started**, not all time. When the result says
  `sample_too_small`, do not draw a conclusion from the ratio.
- A low ratio right after an engine upgrade, a cache wipe or the first open of a project is
  expected, not a fault.
- `project_file_missing: true` means the `.uproject` is gone; that data is probably unused. Offer
  that as a fact, not as a cleanup you will do — clearing cache means recompiling shaders next
  time, and that is the user's call.

ZenServer starts and stops with the editor. If the tool cannot reach it, the editor is closed,
the project does not use Zen for its local cache, or the port was changed — do not go scanning
`Zen/Data` on disk instead; the CAS folder holds so many small files that a walk takes minutes.

## Plugins

`ue_manage_plugin` queries, enables and disables by name. It reports `requires_restart` — when
that is true, the change does not take effect until the user restarts the editor, and you must
tell them. Enabling a plugin the user did not ask for is not a fix; propose it first.

Before disabling one, check who depends on it: `grep_local_files` its name across the project's
`*.Build.cs`, `*.uplugin` and `.uproject`. Assets built on its classes stop loading too, and no
tool lists those — tell the user that risk before going ahead. After the restart, confirm the
state with `ue_get_project_info`.

Enable and Disable rewrite the project's `.uproject`, and the tool reads the file back before
reporting success. So `success: false` here means the plugin is genuinely still in its old
state — never tell the user to restart on a failed call. It happened once: the tool said
"Plugin enabled. Restart required.", the entry was never written, and the user restarted twice
for nothing.
