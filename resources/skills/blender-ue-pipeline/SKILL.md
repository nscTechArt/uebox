---
name: blender-ue-pipeline
description: Connects Blender to Box, then refines UE static props or architectural meshes in Blender with reference-guided modeling and visual quality checks and returns an editable copy to UE. Use when the user requests Blender互联、DCC管道、送到Blender修改、回传UE、按参考图完善道具、提高Blender建模质量, or asks to connect, set up or troubleshoot Blender at all — "我装了 blender 连一下"、"接入 Blender"、"Blender MCP 连不上"、"blender 端口 9876". Do not use for skeletal characters, animation, complete scene synchronization, external image-to-3D generation services, or simple UE-only geometry edits.
---

# Blender ↔ Unreal static mesh pipeline

This workflow keeps the original UE asset, saves a real `work.blend` source file, and
updates one mapped return asset on subsequent revisions. It does not promise that
connecting Blender gives an Agent expert sculpting or photo-reconstruction ability.

## Prerequisites

Use the **official Blender Lab** MCP, not a similarly named community package.
Connection setup and the compatible Python SDK constraint are in [references/setup.md](references/setup.md).

**When Blender is not connected yet, send the user to Preferences → MCP → Connect Blender**, which
installs the official server and add-on and fills in the configuration. Do not walk them through
the manual steps or run `setup_mcp.ps1` yourself unless that button reported something it cannot
do. Never tell the user that connecting Blender is impossible here — it is one button.

The manual path uses `setup_mcp.ps1` on Windows and `setup_mcp.py` on macOS. The Mac installer
accepts a Blender `.app` and records its executable path; Linux installation is not covered.
Verify the actual Blender bridge and UE exchange on the target machine before claiming the
integration works.
Before modeling, read [references/modeling-quality.md](references/modeling-quality.md).
It adapts img2threejs's reference analysis, staged form building and evidence-based correction
to native Blender modeling. The editable `.blend` remains the modeling source of truth.
Resolve the actual connected Blender instance and UE project before mutations.
The MCP handshake alone does not prove Blender is reachable: execute a query for
`bpy.app.version_string`, `bpy.data.filepath`, and the current scene.
A refused bridge connection is not a reason to stop and ask the user to open Blender: Box starts
the configured Blender and repeats that call once. Report a failure that survives it, including
the stated remedy. That automatic start needs `BLENDER_PATH` in the server's environment, and
without it Box cannot launch anything — the error says so by name. Do not keep retrying a bridge
call, or claim Blender is being started, when the error asks for that variable; relay it.
Work that needs no viewport can also run through
`execute_blender_code_for_cli(blend_file, code)`, which the official server executes in its own
background Blender; the saved `.blend` stays the modeling source of truth either way.

The official execution tool may return an MCP success envelope containing
`{"status":"error","message":...}`. Require both MCP success and `status == "ok"`.
Do not proceed on an error, missing output, disconnected session, or timeout.

The UE side requires Python and Geometry Scripting. Use `ue_run_python_script`;
do not introduce a new C++ plugin dependency. Keep requests sequential within one exchange.

## Scripts to execute

Resolve absolute paths to these bundled skill files. Never guess an installation path.

- [scripts/ue_exchange.py](scripts/ue_exchange.py): execute **in the bound UE Editor** using
  `runpy.run_path(script_path)`. `send_asset(source, target, directory_path=None)` exports the
  source and records the mapping. `return_asset(directory_path, preserve_bounds=True)` stages,
  validates, writes, reads back, and saves the mapped return copy.
- [scripts/blender_exchange.py](scripts/blender_exchange.py): execute **inside Blender through MCP**.
  `open_exchange(directory_path)` imports into a fresh dedicated instance and saves `work.blend`.
  `export_exchange(directory_path)` saves the editable source and exports evaluated geometry.
- [scripts/exchange.py](scripts/exchange.py): shared file contract loaded by both scripts;
  do not invoke it as a separate operation. It validates asset paths, hashes, identity, and bounds.
- [scripts/setup_mcp.ps1](scripts/setup_mcp.ps1): execute in Windows PowerShell **only when
  setting up this requested integration**. Supply actual `-BlenderPath` and `-PythonPath`;
  it installs a pinned official server in a separate environment, builds the official add-on,
  installs and enables it, verifies both by reading the state back out of Blender, and writes
  `mcp-entry.json`. Re-running it repairs an install whose add-on step never happened.
  It does not overwrite Box settings or download anything during ordinary modeling calls.
- [scripts/setup_mcp.py](scripts/setup_mcp.py): the macOS setup entry point, run with Python 3.11+
  **only when setting up this requested integration**. Pass `--blender-path` with the actual
  `.app` or executable. It installs the same pinned server and add-on in the user's Application
  Support directory, verifies installation and enablement, and writes `mcp-entry.json` for import.
  It refuses an unrecognized or incomplete directory and leaves its files intact.
- [assets/quality-plan.example.json](assets/quality-plan.example.json): copy and adapt into the
  exchange's `quality-plan.json` **before a modeling edit**, using this subject's actual features,
  references, topology expectations and performance budget. It is a template, not a universal prop.
- [scripts/capture_review.py](scripts/capture_review.py): execute with a **new background Blender
  process**, after export, to render the saved model from the plan's views and write
  `quality-captures.json`. It leaves the modeling file untouched; these are clay geometry views.
- [scripts/quality_review.py](scripts/quality_review.py): execute with Python and the absolute
  exchange directory after inspecting captures and writing `quality-review.json`. It checks
  geometry, per-feature verdicts and evidence freshness. UE return runs the same check automatically.
  A script pass verifies the recorded evidence; it does not independently judge likeness or self-intersections.

Example UE call, substituting discovered paths and the user's intended asset names:

```python
import runpy
bridge = runpy.run_path(ue_script_path)
output_data = bridge['send_asset'](source_package_path, new_return_package_path)
```

Example Blender call, using the exact directory returned above:

```python
import runpy
bridge = runpy.run_path(blender_script_path)
result = bridge['open_exchange'](exchange_directory)
```

## Workflow

1. Find the requested static mesh, confirm the bound project, and inspect materials, source
   LOD count, dimensions, and collision. Save only the intended source if it is dirty.
   The first version supports **one source LOD with distinct, assigned material names**.
   Report unsupported assets before exporting; never remove their LODs or material slots to pass.
2. Choose an unused `/Game/...` return path, usually the source name with `_DCC` appended.
   Tell the user that the first return is a new copy and later updates reuse that copy.
   The original stays available. Do not silently replace existing level instances with the copy.
3. Run `send_asset`. Default sources live beside the `.uproject` under
   `SourceArt/UnrealBox/<exchange-id>/`. The directory contains `manifest.json` and `source.fbx`;
   it is authored data, not a cache. Keep it with the project or in its chosen source-art location.
4. In a **fresh separate Blender instance**, run `open_exchange`. It refuses to replace a
   document already in use. On later sessions, reopen the recorded `work.blend`; do not import
   `source.fbx` again or clear a user's open scene. This is the editable modeling source.
5. Write the subject-specific quality plan, then edit the tagged object through Blender MCP.
   Work in reviewed stages: proportions/silhouette → structure/attachments → local details →
   surface response and delivery. Fix the earliest wrong stage before adding more detail.
   Use Blender modifiers, mesh tools, and UV tools
   as appropriate. Query available Python APIs through the official MCP docs tools.
   Preserve the object's identity, origin, and numbered `UBX_SLOT_...` material slots.
   Apply operations to this object only. Keep construction decisions and intermediate reviews on
   disk next to the `.blend`, so resuming a task does not rely on conversation memory.
6. Run `export_exchange`. This evaluates modifiers into `edited.fbx` while retaining the
   modifier stack in `work.blend`. Capture front/right/rear/left and an oblique view, plus planned
   reference views and detail close-ups. Inspect the actual images before recording a verdict for
   every feature. Run the quality check. A missing critical feature or stale evidence blocks return;
   triangle counts and a good global score cannot override a failed visual requirement.
7. Run `return_asset` in the originally bound UE project. It imports into a staging asset,
   checks counts, bounds and material identity, then updates the mapped copy and reads it back.
   Bounds are preserved by default (1 mm tolerance); use `preserve_bounds=False` only for an
   explicitly requested dimension change and verify the requested final dimensions afterwards.
8. Show the UE return asset and report before/after counts and dimensions. Inspect material
   assignment, shading, UV/lightmap behavior, and collision in UE. The original UE materials
   are reused; Blender shader graphs are **not** translated. Collision is retained from the source
   and may no longer fit changed geometry: rebuild and test it when required by the task.
9. For another edit, return to `work.blend`, export again, and return to the same mapped asset.
   Existing level instances of **that return asset** must keep their transforms and references.
   Reopening UE and re-reading proves persistence; same-session `load_asset` alone does not.

## Failure handling

- Changed source/target fingerprints, wrong project, malformed manifest, material mismatches,
  empty geometry, and unexpected bounds stop the return. Never rewrite the manifest to bypass a failure.
- Never delete the quality plan, drop a failed feature, inflate a score or reuse old screenshots to
  pass. Existing exchanges without a quality plan still support transport; they are not evidence
  that modeling quality was reviewed. Add a plan and export again before claiming visual acceptance.
- A return timeout means completion is unknown. Inspect the target and the exchange revision;
  do not blindly repeat the write. Identical successfully recorded exports are no-ops.
- If validation fails, inspect the reported staging asset. Never delete arbitrary staging folders
  or the source. The script restores the previous geometry if a later revision fails while writing.
- A first-return copy can remain after a failed write for inspection. Report it honestly;
  do not call it a successfully delivered model.
- Source meshes with LOD chains, merged/split asset identities, new material slots, rigging,
  animations, hair, or complete UE/Blender material conversion need a separate workflow.
