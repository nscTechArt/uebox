# Reuse and scale — parameter collections, material functions, references

Read this when the ask is bigger than one material:

- **"全场景下雨"、"昼夜切换时整体变暗"** → parameter collection
- **"受击闪白"、"选中的单位发光"、"按队伍改配色"** → per object, not a collection — see below
- **同一串节点要用在好几个材质里** → material function
- **要改或要删一个被别处引用的资产** → check the referencers first

## Contents

- One switch driving the whole level — parameter collections
- One object, while the game runs — dynamic instances and custom primitive data
- Reusing a group of nodes — material functions
- Before you change or delete anything — check who uses it

---

## One switch driving the whole level — parameter collections

When the ask is "make it rain across the level" or "darken everything at night", the answer
is a **Material Parameter Collection**, not a pass over every material instance.

A collection is **global**: every material that reads `Wetness` reads the same one value.
Put a hit flash in it and every character flashes when one is hit. Use it only when the
whole level really should change together.

`material_parameter_collection` creates and edits the collection:

```json
{ "action": "create", "collection_name": "MPC_Weather",
  "scalars": [{ "name": "Wetness", "value": 0 }] }
```

Then reference the parameter from each material that should react to it, with
`material_apply_graph`:

```json
{ "path": "/Game/M_Ground", "nodes": [
  { "id": "wet", "node_type": "CollectionParameter",
    "collection_path": "/Game/Materials/MPC_Weather", "node_name": "Wetness" }] }
```

`collection_path` and `node_name` are **both required** — with either missing the node is
created but greyed out, and the material only fails at compile time with "Missing Parameter
Collection". The tool reports `collection_applied: false` when that happens; do not wire a
node up after seeing that.

Scalars and vectors are capped at **16 each** by the engine. Past that the extra parameters
are rejected and named in `rejected` — they are not silently dropped, but they are also not
there, so check the message rather than assuming the write landed.

## One object, while the game runs — dynamic instances and custom primitive data

Per-object values change at runtime all the time; they just do not go through these tools.
`material_set_param` edits a **MaterialInstanceConstant asset** — every actor using that
asset shares the value, and it is set in the editor. Runtime, per-object changes are made by
the game:

- **Default — Dynamic Material Instance.** The material needs a `ScalarParameter` /
  `VectorParameter` (say `HitFlash`, wired into an emissive term). In Blueprint, *Create
  Dynamic Material Instance* on the hit actor's mesh component, then *Set Scalar Parameter
  Value* `HitFlash` on that instance. Only that actor changes.
- **Hundreds of actors sharing one material — Custom Primitive Data.** Give the parameter
  node `properties: { "bUseCustomPrimitiveData": true, "PrimitiveDataIndex": 0 }` in
  `material_apply_graph`; at runtime the component calls *Set Custom Primitive Data Float*
  (index 0). No per-object material is created, so the actors can still be drawn together,
  which hundreds of separate dynamic instances cannot. (It is per component: the instances
  inside one Instanced Static Mesh component all share it.)

Team colours that never change during play are simpler still: one instance asset per team
(`material_create_instance`), assigned per actor.

The Blueprint half belongs to skill `ue-blueprint-graph-editing`. Verify it in PIE — hit one
enemy and check that only that one flashes — not by reading the graph.

## Reusing a group of nodes — material functions

The same chain of nodes appearing in three materials should be a **MaterialFunction**: edit
it once, all three follow. Rebuilding it per material means that after the third copy nobody
dares change it.

`material_create_function` makes one:

```json
{ "function_name": "MF_Wetness", "destination_path": "/Game/Materials" }
```

The function is created **empty, and the material graph tools cannot fill it.** Every graph
command loads a `UMaterial`; handed a function path they answer `Material not found`, and
`FunctionOutput` is not among the node types that can be created. Do not retry them on a
function.

When the user wants the function, fill it with `ue_run_python_script` through
`unreal.MaterialEditingLibrary`: `create_material_expression_in_function` for each node
(including `MaterialExpressionFunctionInput` / `MaterialExpressionFunctionOutput`),
`connect_material_expressions` for the wires, then `update_material_function`. The script's
own printout is not proof — read the function's expressions back before reporting it done.
If the user would rather not have a function, build the same nodes inside each material.

A function that is already filled in works normally. Call it from a material:

```json
{ "path": "/Game/M_Ground", "nodes": [
  { "id": "wet", "node_type": "MaterialFunctionCall",
    "function_path": "/Game/Materials/MF_Wetness" }] }
```

`function_path` is required. Without it the node is created with **no pins at all**, and the
first sign of trouble is a missing-pin error on the wire two steps later.

## Before you change or delete anything — check who uses it

`material_get_referencers` answers "what depends on this asset". It is read-only.

Use it before editing a master material (it may have a dozen instances inheriting from it,
all of which shift with your change) and before deleting a texture (something may still
reference it). The response tags each referencer with its class, so a material instance and
a level are distinguishable without a second lookup.

Reporting "I updated the material" without mentioning that it changed twelve instances is
a partial answer. Check first, then say what the blast radius was.
