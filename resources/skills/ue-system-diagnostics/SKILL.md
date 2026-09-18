---
name: ue-system-diagnostics
description: Run console commands and Python inside the editor, read performance numbers, check crash reports, and enable or disable plugins. Use when the task needs something the dedicated tools cannot express, or when the user asks about performance, crashes or plugins. Do not use for ordinary asset, actor or Blueprint work — those have their own tools.
---

# System, Python and diagnostics

Verified against UE 5.5.4 with UnrealAgentLink. These are the highest-privilege tools in the set:
five tools, of which three — `ue_run_console_command`, `ue_run_python_script` and
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

### "Can do anything" is about capability, not permission

Where another skill says a thing must not be done, that ruling wins here too — Python does not
become the way to do it anyway. `ue-sequencer` is the explicit case: it forbids editing a user's
sequence through `ue_run_python_script`, and an approval prompt does not overturn that. The
user approving a script means they accept it runs, not that they re-authorised what a domain
skill already ruled out.

Approval is the last gate, not the first. If a dedicated tool exists, use it; if a skill forbids
the operation, say so instead of scripting around it.

## Console commands return their output

`ue_run_console_command` now reports what the command printed:

```
r.ScreenPercentage  →  r.ScreenPercentage = "100"   LastSetBy: Scalability
```

Commands that only toggle an on-screen overlay (`stat unit`, `stat fps`) produce no text, and the
result says so — that is normal, not a failure. Some commands only write to the engine log; use
`ue_message_log` for those.

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
- `> 0` → real reports from `Saved/Crashes`, worth analysing.

## Plugins

`ue_manage_plugin` queries, enables and disables by name. It reports `requires_restart` — when
that is true, the change does not take effect until the user restarts the editor, and you must
tell them. Enabling a plugin the user did not ask for is not a fix; propose it first.

Enable and Disable rewrite the project's `.uproject`, and the tool reads the file back before
reporting success. So `success: false` here means the plugin is genuinely still in its old
state — never tell the user to restart on a failed call. It happened once: the tool said
"Plugin enabled. Restart required.", the entry was never written, and the user restarted twice
for nothing.
