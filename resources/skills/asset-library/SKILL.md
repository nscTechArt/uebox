---
name: asset-library
description: Search and curate the box's own asset library — find assets the user has collected, read and write their notes and tags, move assets between library folders, create rename and delete those folders, and delete or restore library entries such as duplicate registrations. Use when the user asks what is in their library, wants to find a model or texture they own, wants assets organised, or says things like "帮我把重复的清理了"、"把这几个素材归到一个文件夹"、"删错了恢复一下". Do not use for assets inside an Unreal project or loose files on disk.
---

# The box's asset library

Verified against a live library. This is the user's **curated collection** — assets they gathered,
tagged and annotated. It is a different thing from the two other places assets live:

| Where | Tool |
|---|---|
| The box's library (tagged, annotated) | `search_assets` — this skill |
| Inside the open Unreal project | `ue_content_search` |
| Loose files on disk | `find_local_files` |

Picking the wrong one is the most common failure here. "我素材库里有没有…" is this library.
"这个工程里有没有…" is the project.

## Asset names are English

Unreal assets are named `SM_Chair_Wood`, `T_Wood_Diffuse`, `SK_Hero`, and the user asks in
Chinese. Searching 椅子 finds nothing that `chair` would have found.

You do not have to translate up front and you should not guess. When a Chinese keyword returns
zero, `search_assets` re-runs the search without the keyword and hands back `library_sample` —
real assets from the library, with `dropped_query` naming what it removed. Pick the English word
off that sample; it beats guessing, and a miss tells you almost nothing on its own.

Tags are the exception. Chinese tags the user (or you) applied **are** searchable in Chinese, so
after tagging, `家具` finds the chair that `椅子` could not.

## Browsing

Call `search_assets` with no arguments to list the whole library. That is the right first move for
"我素材库里有什么" and for getting your bearings before organising anything.

## Filtering

Filter at the source instead of paging the whole library and sorting it out yourself:

| Ask | Argument |
|---|---|
| "Trees 文件夹里有什么" | `folder: "Trees"` — name, `/full/path`, or `folderKey`; subfolders included unless `includeSubfolders: false` |
| "带'角色'标签的" | `tags: ["角色"]`, plus `tagsMatch: "all"` when every tag must be present |
| "除了废弃的" | `excludeTags: ["废弃"]` |
| "我收藏的" | `favorite: true` |
| "最近改过的" | `changedAfter: "2026-08-01"` / `changedBefore` |
| "回收站里有什么" | `deleted: true` (paging only — no other filter works with it) |

Two failure modes worth knowing:

- A **folder name that matches more than one folder is an error**, not a guess. The error lists the
  candidates with their full paths; ask the user which one rather than picking.
- A **tag name that does not exist is an error** too. Without that, an empty filter would come back
  as the entire library and you would report all of it as "assets with that tag".

`changedAfter` / `changedBefore` read the **last-modified** time, which annotating an asset also
refreshes. It is not an "imported on" date — do not present it as one.

## Picking assets to import into a project

Two things decide whether a library asset can actually land in the project the user has open,
and both are visible **before** you import — check them while you are still choosing, not after
half the batch has failed.

**Engine version.** A `.uasset` only opens in a project of the same or a newer engine version.
Every result carries `engineVersion` when the library recorded one, and `search_assets` takes
it as a filter: picking for a 5.5 project, pass `engineVersion: ["5.5", "5.4", "5.3"]` and the
5.7 assets never enter your shortlist. (A real run skipped this and got 34 of 51 imported;
16 of the 17 failures were one line repeated: 资产引擎版本 (UE 5.7) 高于目标项目版本 (UE 5.5).)
Loose files — `png`, `fbx`, `glb` — have no such limit; they go through `ue_content_import`.

**Which vault they live in.** Search reads across *all* vaults; importing only works out of the
**active** one. When the keys you picked live somewhere else, `project_manage`'s `import_assets`
now says so in one message before copying anything — "这批 N 个在「FPS」里，当前活跃的是
「AIGC 资产库」" — and the way out is `switch_vault`, which asks the user for confirmation.
Read that message as "wrong vault", never as "the user does not have these assets".

## Filtering by kind

- `assetType` takes Unreal type names: `StaticMesh`, `Texture2D`, `Material`, `SkeletalMesh`.
- `fileFormat` takes extensions (`fbx`, `png`) or Chinese aliases (`模型`, `贴图`, `材质`, `蓝图`).

An alias matches on **either** the file extension or the asset type, because the same kind of
thing can arrive as an imported `.fbx` or as an engine `.uasset`.

**Check `relaxed` in the result.** When nothing matches the type you asked for, the search widens
and returns other assets instead. `relaxed: true` means *what came back is not the type you asked
for* — say that to the user rather than presenting the list as matches.

## Notes and tags round-trip

Search results carry `note` and `tags` when the asset has them. Read them before writing:

`annotate_asset` writes both. Its two halves behave differently:

- `note` **overwrites**. If the asset already has a note, you are about to destroy what the user
  wrote unless you incorporate it.
- `tagNames` adds; re-adding an existing tag is pointless noise. Unknown tag names are created.

One call can do both — pass `note` and `tagNames` together rather than making two round-trips.

It also writes a batch: `assetKeys` for a list, or `folder` for a whole library folder
(subfolders included unless `includeSubfolders: false`). Tagging a 300-asset pack is one call, not
300 — and one approval instead of 300. Above 200 assets, `folder_selection.hasMore` comes back
with `nextFolderOffset`; pass it as `folderOffset` to continue. Remember `note` overwrites *every*
asset in the batch.

`hasNoTags: true` finds everything unlabelled — the natural starting point for "帮我把素材库整理
一下". Propose a tag scheme from what you find and get agreement before applying it in bulk; a
library retagged to someone else's scheme is worse than an untagged one.

**Read `list_tags` before you write tags.** Unknown tag names are created silently and land
outside the user's tag groups, so guessing produces 树 / 树木 / Tree as three separate tags and
quietly shreds their scheme. `list_tags` shows what exists, which group each tag belongs to, and
how many assets carry it — high counts are the real categories, ones and twos are usually strays
worth merging. It is also where the exact spelling for `search_assets`'s `tags` filter comes from.

**Tags are editable, so the mess is fixable.** `manage_tags` renames one (`newName`, associations
survive — every asset keeps the tag), recolours it, or marks it a favourite. `delete_tags` takes
them out: with `mergeInto` it moves the assets onto the target tag first, which is how 树 / 树木 /
Tree become one tag without any asset losing a label; without it the tag is simply gone and the
assets are one label poorer.

There is **no recycle bin for tags** — a deleted tag does not come back. Read out the list and
each tag's asset count from `list_tags` and get agreement before deleting or merging.

`assetKey` is how every write identifies its target, and it only comes from a search result. There
is no way to guess it.

## Saved snippets are a different library

The asset library holds files. The **snippet** library holds pieces of Unreal work the user saved
to reuse — blueprint graphs and materials:

- `library_search` — find saved blueprint / material snippets. This is the entrance for "I saved
  something like this before", which `search_assets` cannot answer: it searches files, not graphs.
- `blueprint_library_save` — store a graph the user wants to reuse later.
- `blueprint_library_apply` — drop a saved graph into a blueprint.

Keep the two apart when reporting: a mesh lives in the asset library, a door-opening graph lives
in the snippet library, and telling the user you "found it in the library" without saying which
one sends them to the wrong panel.

## Organising: folders and moving

`create_folders` makes the folder, `move_assets` puts things in it. Neither touches the disk —
library folders are a classification, not directories, and the files stay where they are.

`move_assets` takes a `targetFolder` (name, full path, or `folderKey`) plus either `assetKeys` or
`sourceFolder`. Assets already in the target come back as `already_there`, which is not a failure.
A tidy-up is usually one `search_assets` per group, then one `move_assets` per group — not one
call per asset.

`sourceFolder` empties one folder into another without you listing its contents first. It moves
**only that folder's own assets**; `includeSubfolders: true` sweeps the whole subtree, which
flattens it into the target — say that out loud before doing it. Above 200 assets it moves the
first batch and sets `source_folder.hasMore`; call again with the *same* arguments to continue
(what moved is no longer in the source, so there is no offset to pass).

Say what you are about to reorganise before you do it. "把素材库整理一下" is not agreement to a
particular scheme; a library rearranged into someone else's scheme is worse than a messy one.

## Deleting

`delete_assets` takes `assetKeys` and moves those entries to the library's recycle bin. It is a
soft delete: the user can restore them in the UI, and **nothing on disk is touched**. Every call
asks the user for approval, so batch the keys instead of calling it once per asset.

Read the result rather than assuming it worked. Each key comes back with its own `status`:
`deleted`, `not_found`, `denied`, `failed`, or `unconfirmed` — the last one means the delete ran
but the record was still there on read-back, which is not a success and must be said out loud.

Names repeat in a library. Before deleting more than one thing, list what you are about to remove
(name, path, `assetKey`) and get agreement — `assetKey` is the only thing that distinguishes two
assets called `SM_Tree`.

### Undoing a delete

`restore_assets` takes the same `assetKeys` back out of the recycle bin. `delete_assets` returns
every key it removed, so when a delete turns out to be wrong — a name collision, the user changes
their mind — restore it yourself instead of telling them to go dig through the UI.

`search_assets` with `deleted: true` lists what is in the recycle bin when you no longer have the
keys.

### Duplicate registrations

The same folder imported twice leaves two rows for one file: same path, same size, two
`assetKey`s. Spot them by listing the library (`search_assets` with no keyword, paging with
`nextOffset`) and grouping on `path` + `size`. Keep one key per group and delete the rest.

Duplicates share the file they point at, so `delete_assets` may return `shared_file_warnings`.
That means the surviving row uses the same file as the one you just removed: leaving the deleted
entries in the recycle bin is fine, but **emptying the recycle bin would delete that file** and
leave the survivor pointing at nothing. Pass that on to the user.

## Folders

`create_folders` makes folders **inside the library** — database records, not directories on disk.
`parentFolderKey: "ALL"` puts them at the root, and children nest in one call. Nothing moves on
the user's filesystem; use `move_assets` to put assets into them.

`rename_folder` fixes a name, `delete_folders` removes one. Deleting a folder is not just the
folder: **its subfolders and every asset inside go to the recycle bin with it**. The result says
how many assets that was — tell the user that number, not just "folder deleted".

`restore_folders` is the undo for it, and it restores the whole tree — the folder, its subfolders
and the assets that went down with them. Call it with no arguments to list what is in the folder
recycle bin (that is read-only), then pass `folders` with a name, full path or `folderKey`. Use
this rather than `restore_assets` after a folder delete: restoring the assets alone brings them
back without the structure they lived in.

On a **network vault** both refuse and say so: renaming and deleting there also have to move real
directories on the share, which these tools cannot do. Half of that operation would leave the
library and the disk disagreeing, so the user does it in the UI instead.
