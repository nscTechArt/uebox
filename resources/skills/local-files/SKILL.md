---
name: local-files
description: Work with files on the user's own computer — list a directory, find files by glob, search contents, read text or images, write and edit files, and run shell commands where a shell exists. Use when the user names a path outside the Unreal project, wants source or config files changed, or asks to import files from disk. Do not use for assets already inside the Unreal project.
---

# Files on the user's computer

Seven tools, none of which need Unreal to be connected. They exist because every other tool in the
box works on assets that are *already* in the project — nothing could look at the disk the user
actually keeps their source files on.

Read: `list_local_dir`, `find_local_files`, `grep_local_files`, `read_local_file`.
Write: `write_local_file`, `edit_local_file`. Run: `run_shell_command` (only where a shell exists).

## `list_local_dir` — before you act on a folder, look inside it

```
list_local_dir(path: "D:/素材/建筑")
list_local_dir(path: "D:/素材/建筑", pattern: ".fbx")
```

Directories come first and are marked `[目录]`; files show their size.

When the user says "把这个文件夹里的模型导进来", list it first. Do not infer contents from the
folder's name, and do not guess file paths to hand to `ue_content_import` — that tool takes
concrete paths, and a guessed one simply fails.

Capped at 200 entries. When more exist, the header says so — pass that on to the user rather than
quietly acting on the first 200. Use `pattern` to narrow before resorting to summarising.

## `read_local_file` — text and images

```
read_local_file(path: "I:/Proj/Saved/Logs/Proj.log")
read_local_file(path: "I:/Proj/Config/DefaultEngine.ini", offset: 40, limit: 30)
read_local_file(path: "C:/Users/me/Desktop/reference.png")
```

**Images come back as pictures you can actually see.** When the user says "参考这张图" and gives a
path, read it and describe what you see before proposing anything — do not ask them to describe
their own reference.

Long files are truncated with a note telling you the offset to continue from. Read the part you
need rather than pulling a 200 MB log into the conversation.

This reads files on disk. `.uasset` files are binary — to inspect a project asset use
`ue_content_describe` or the material and Blueprint tools, not this.

## What is off limits

Credential and browser-data locations are refused: the box's own key store, `.ssh`, `.aws`,
`.gnupg`, Chrome and Firefox profiles. If a task seems to need something from those, ask the user
to look and tell you — do not try another path spelling to get around it.

Everything else on disk is readable. The user naming a path is the authorisation; you should still
say which file you are about to open when it is outside their Unreal project.

## `find_local_files` — locate files across directories

```
find_local_files(path: "D:/素材", pattern: "**/*.fbx")
find_local_files(path: "I:/MyProject", pattern: "**/Default*.ini")
```

Use this instead of walking down with `list_local_dir` when the file could be at any depth.
Patterns are glob, relative to `path`; cross-directory patterns need a leading `**/`.

Four Unreal directories are always skipped: `DerivedDataCache`, `Intermediate`, `Binaries`,
`Saved` — plus `.git` and `node_modules`. They hold engine-generated output (compile
intermediates, shader caches, logs) that nobody searches for, and they dwarf the real content.
If the user genuinely wants something from a build output directory, read it directly by path.

## `grep_local_files` — search inside files

```
grep_local_files(path: "I:/MyProject", pattern: "Nanite", glob: "**/*.ini")
```

Narrow with `glob` before searching wide. Files containing NUL bytes (`.uasset`, `.fbx` and other
binaries) are skipped — to search project assets use `ue_content_search`, not this.

An invalid regex is reported with the exact parser error. Read it and fix the pattern rather than
trying a different spelling of the same mistake.

Both tools cap their results and say so in the header when they hit the cap. Pass that on: "找到前
200 个" is a different answer from "找到 200 个".

## Writing and editing

`write_local_file` creates a file or **replaces one entirely**. `edit_local_file` replaces exact
snippets and can make several disjoint changes in one call.

Reach for `edit_local_file` whenever the file already exists and you only need part of it changed.
`write_local_file` discards everything you did not include — including the parts you never read.

For edits:

- `oldText` must match the file **character for character**, indentation and newlines included. A
  miss fails the whole call rather than applying half of it.
- Every `oldText` is matched against the **original** file, not the result of your earlier edits in
  the same call. Do not write overlapping or nested edits.
- Keep each `oldText` just long enough to be unique. Padding it with unchanged surrounding lines
  wastes context and makes near-miss failures more likely.
- Read the file first. Editing from memory of what a file "usually" looks like is how you get an
  exact-match failure and burn a turn.

Both ask the user for confirmation every time — they modify the user's own disk, not regenerable
project assets. Say plainly which file you are about to change and what the change is.

## Running commands

`run_shell_command` runs bash. **It is only present when the machine actually has a shell** (Git
for Windows, typically) — if you do not see the tool, that machine does not have one, and the
answer is to use the file tools or ask the user to run the command themselves.

Prefer the dedicated tools where they fit: `list_local_dir`, `find_local_files`,
`grep_local_files`, `read_local_file`. They are faster, produce tidier output, and work on every
machine.

For Unreal C++ specifically:

- Build with UnrealBuildTool, not by invoking the compiler directly.
- **The editor holds the module DLLs open.** A rebuild will fail at the link step while it is
  running. Tell the user the editor needs closing and let them close it — do not kill the process
  yourself.
- Live Coding can be pinned to an MSVC toolset that is no longer installed, in which case hot
  reload fails and a full rebuild with the editor closed is the only path. Read the error rather
  than retrying the same build.

## `inspect_uasset_file` — read a .uasset without opening the engine

`read_local_file` gives you text. A `.uasset` / `.umap` is not text — reading it raw gets you
binary noise. `inspect_uasset_file` parses the package header off disk and tells you what is
actually inside: class, referenced packages, basic properties.

Use it when the editor is closed, when the project will not open, or when you only need to answer
"what is this file" without paying the cost of loading a project. When the editor *is* running and
you need live state, the engine's own tools know more — this one only sees what was written to disk.

## What is deliberately missing

There is no delete tool. Removing, renaming or moving the user's files is not something to do
through a side channel — say what needs doing and let them do it, or work inside Unreal where the
content tools handle it properly.
