---
name: knowledge-base-and-projects
description: Read and add sources to the user's knowledge base, list and create Unreal projects from templates, tidy the project library into collections, and import assets from the box's library into an Unreal project. Use when the user wants researched material saved to a knowledge base, wants to recall material from the bound knowledge base, wants their projects grouped, sorted or pinned on the home screen, or wants assets moved from their library into an Unreal project. Do not use for a standalone note: notes are an internal knowledge-base source type and have no separate user-facing entrance.
---

# Knowledge base and projects

Verified against a live box. Only two things here need Unreal running: importing an external file
(FBX/PNG/OBJ) and placing actors in a level. Everything else, `.uasset` import included, works with
the project closed.

## Knowledge base

A text source is an implementation detail inside a knowledge base. Saving research belongs in a
knowledge base, not in a note — `create_note` writes an asset's or folder's "detailed note", which
is a different thing with a different entrance (the asset library's details panel).

Notes are the other half, and they are separate from knowledge bases:

- `search_notes` — search or list the user's notes.
- `get_note` — read one in full.

Reach for these when the user refers to something they wrote down ("我之前记过"), rather than to
research they collected. Searching the knowledge base for it will come back empty and read as
"you never wrote that", which is worse than looking in the right place.

Knowledge-base tools use the knowledge base currently bound to the conversation when one exists:

- `search_notebook_sources` searches its existing sources.
- `add_notebook_source` adds either a web page or a text source. If no knowledge base is bound, it
  creates a new one so the result still has a real user-facing home.

If the user names an existing knowledge base but the conversation is not bound to it, tell them to
type `/wiki` and choose that target before saving. Do not create a duplicate with the same name.
Never fall back to a note, a local file, or the chat transcript.

For a web source, give `add_notebook_source` its URL and let the tool fetch the page. For a report
you wrote, give it a clear title and Markdown content. Only say the material was saved after the
tool succeeds, and name the knowledge base reported by the tool so the user knows exactly where
to verify it.

## Projects

Split in three by how much damage they can do:

**`project_list`** (never asks) — `list_templates`, `list_projects`.

**`project_organize`** (tidies the library, touches no project files) — `group_projects`,
`ungroup_projects`, `pin_projects`, `update_collection`, `delete_collection`.

**`project_manage`** (asks every time) — `create_project`, `open_project`, `import_assets`,
`import_assets_to_scene`, `setup_level_sequence`.

If you call an action on the wrong one, the error names the tool that has it.

### Tidying the project library

"按虚幻版本帮我把项目分个组" is `project_organize`, one call per group:

```
project_list(action: "list_projects")   → engineVersion, collection, pinned, plus collections
project_organize(action: "group_projects", collection: "UE 5.5", projects: [...])
```

Read `list_projects` first. It reports which collection each project is already in and which
collections exist (empty ones included), so you do not re-sort projects that are already grouped
and do not create a second collection with a name that is taken.

`group_projects` creates the collection when it does not exist yet and fills it in the same call.
There is no create-an-empty-collection action on purpose: the home screen only renders collections
that contain projects, so an empty one is invisible to the user.

**A project belongs to exactly one collection.** Adding it to B takes it out of A — the reply's
`left_collection` says which one it left, and that belongs in what you tell the user.

`delete_collection` dissolves the grouping only. Every project stays in the library; the reply says
how many went back to ungrouped. Deleting projects is not something this tool does.

Collection colours, icons and descriptions are columns in the database that no screen renders, so
they are not exposed. If the user asks for a coloured collection, say it cannot be done rather than
writing a field they will never see.

### Importing from the library into a project

This is the one people actually want: "把我素材库里那两把椅子导进工程".

```
search_assets(query: "chair")        → assetKeys
project_manage(action: "import_assets", assetKeys: [...])
```

`assetKeys` come from `search_assets` results and nowhere else — an asset name will not work and
they cannot be guessed.

**Do not open the project first.** A `.uasset` import copies files into `<project>/Content/` and
resolves their dependencies; the engine is not involved, so the project does not have to be running.
Name the target with `projectKey` (from `list_projects`) or `projectPath`; without either, the
import goes to whichever project is currently open. Opening a project just to import costs the user
a full editor launch and changes nothing about the result.

```
project_manage(action: "import_assets", projectKey: "<from list_projects>", folder: "SoStylized")
```

Two exceptions still need the editor running. External files (FBX, PNG, OBJ — anything that is not
`.uasset`/`.umap`) go through the engine's import API. If a batch mixes both and the project is
closed, the `.uasset` assets still import and each external file is listed separately in `details`
— tell the user which ones are waiting on the project being opened, do not report the batch as a
clean success.

**A whole folder goes in one call — do not enumerate it.**

```
project_manage(action: "import_assets", folder: "SoStylized")
```

`folder` takes a folder name, a full path (`/ALL/SoStylized`) or a folderKey, and includes
subfolders unless you pass `includeSubfolders: false`. Paging a 776-asset folder through
`search_assets` to collect keys is wasted work: the folder is the selection.

At most 200 assets are imported per call. The reply's `folder_selection` says how many the folder
holds and, when `hasMore` is true, gives `nextFolderOffset` — call again with
`folderOffset: <that>` for the next batch. Tell the user how many batches you are running before
you start; importing hundreds of assets is not instant.

The asset lands at the path recorded in the library (its `softPath`), not somewhere you choose.
Confirm with `ue_content_search` afterwards rather than trusting the success message; and note
that a `.uasset` carries its own internal object name, so a file imported under a different
filename still shows the original name in the engine. That is normal, not a failed import.

`import_assets_to_scene` is the second exception: it places actors in the **currently open level**,
so that project does have to be running. Say that plainly before doing it — the user may have a
level open they did not expect to be modified.

## Pointing the user at a screen

There is no navigation tool. If the next step belongs in another part of the box — the asset
library, the knowledge base, AI creation — say so in words and name the screen. The user clicks it
themselves; you do not have a way to move them there.
