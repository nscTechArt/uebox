---
name: ue-level-organize
description: Files actors in the open level into World Outliner folders. Use when the user wants the Outliner tidied, asks to group actors by type or by name, or says things like "把场景整理一下"、"把所有灯放到一个文件夹里". Do not use for optimisation analysis or asset size reports, for moving actors in the world, or for creating and deleting actors.
---

# World Outliner tidy-up

Verified against UE 5.5.4 with UnrealAgentLink. One tool.

This skill only changes **organisation**. Nothing moves in the world, nothing is created or
deleted, and gameplay cannot break. Each call is one undo step (`ue_undo`).

Looking for what is *in* the level and what it costs — triangle counts, missing collision,
heavy assets — is `ue-project-audit`, not this.

## `level_organize_actors`

Moves matching actors into a World Outliner folder. Two ways to select:

```
class: "PointLight"                       simple case
filter: { name_pattern: "SM_Rock*" }      same filter shape as ue_get_actor
```

`class` matches by **substring**: `"Light"` also takes `DirectionalLight` and `SkyLight`. Pass
neither and it takes every actor in the level.

It reports `total_found` and lists each actor with the folder the engine actually set.
**Compare `total_found` with the count you announced.** Matching more than you intended is the
failure mode here, and that number is the only place it is visible — a filter that was meant
to catch 12 rocks and caught 400 actors looks exactly like success otherwise. Run the same
filter through `ue_get_actor` first if you are not sure what it catches.

## Workflow for "把场景整理一下"

1. `ue_get_actor` to see what is actually in the level, grouped by class.
2. Propose the folder structure to the user, with counts: "灯光 12 个 → Lighting，
   静态网格 240 个 → Props/…".
3. Organise once they agree.

Inventing a folder scheme and applying it silently gives the user an Outliner they did not
design and now have to re-learn. Say which actors you are about to file and where, first.

## World Partition and One File Per Actor levels

There every actor is saved in its own file, so filing 400 actors marks 400 files dirty — the
next save writes all of them, and under source control the user has to check them all out.
Say the file count before a bulk move in such a level (`ue_get_levels` reports
`is_world_partition`).
