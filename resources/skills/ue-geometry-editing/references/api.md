# Geometry Script 参数与回读

以下签名和字段在 UE **5.5.4** 的实际 Python 环境核对过。
读写、减面、减法布尔已跑过；重网格和新建资产这里只核了签名，不能当验收通过。
其他版本使用前通过 `help(...)` 核对，不能把 5.5 的所有字段当成九版通用。
示例省略可选的 `debug=None`，所有类名前加 `unreal.`。

## 目录

- 读写资产
- 减法布尔
- 减面
- 均匀重网格
- 查询与判断
- Nanite 与自动 LOD（不改 LOD0）
- 布尔之后：碰撞与 LOD

## 读写资产

```python
mesh, outcome = GeometryScript_AssetUtils.copy_mesh_from_static_mesh(
    static_mesh, dynamic_mesh, GeometryScriptCopyMeshFromAssetOptions(),
    GeometryScriptMeshReadLOD())
mesh, outcome = GeometryScript_AssetUtils.copy_mesh_to_static_mesh(
    dynamic_mesh, static_mesh, GeometryScriptCopyMeshToAssetOptions(),
    GeometryScriptMeshWriteLOD())
asset, outcome = GeometryScript_NewAssetUtils.create_new_static_mesh_asset_from_mesh(
    dynamic_mesh, '/Game/Meshes/SM_Result', GeometryScriptCreateNewStaticMeshAssetOptions())
```

每次都检查 `outcome == GeometryScriptOutcomePins.SUCCESS`。
`copy_mesh_to_static_mesh` 返回的是 DynamicMesh 和 outcome，**不是** StaticMesh。
写入后再创建一个 DynamicMesh 从目标资产读取，最后用 `ue_save` 确认存盘。
读写同一 LOD；默认读取选择和显式写入目标不一致时不能比较面数。

| 参数类型 | 5.5 常用字段（完整列表通过 `help(类型)` 查看） |
|---|---|
| `GeometryScriptMeshReadLOD` | `lod_index`、`lod_type` |
| `GeometryScriptMeshWriteLOD` | `lod_index`、`write_hi_res_source` |
| `GeometryScriptCopyMeshFromAssetOptions` | `apply_build_settings`、`ignore_remove_degenerates`、`request_tangents`、`use_build_scale` |
| `GeometryScriptCopyMeshToAssetOptions` | `emit_transaction`、`defer_mesh_post_edit_change`、`enable_recompute_normals`、`enable_recompute_tangents`、`enable_remove_degenerates`、`replace_materials`、`new_materials`、`new_material_slot_names`、`use_build_scale`、`use_original_vertex_order`、`apply_nanite_settings`、`new_nanite_settings` |
| `GeometryScriptCreateNewStaticMeshAssetOptions` | `enable_collision`、`collision_mode`、`enable_nanite`、`nanite_settings`、`enable_recompute_normals`、`enable_recompute_tangents`、`use_original_vertex_order` |

修改已有模型时，**先复制原资产作为目标**，再 `copy_mesh_to_static_mesh`。
不要为了另存减面结果改用新建 API；它不会自动继承来源资产的材质、碰撞和光照设置。
新建 API 适用于无来源资产的程序化生成。新切面需要的材质映射、碰撞形状和 UV
仍须验证。不要开启 `replace_materials` 后却忘记填材质列表。

## 减法布尔

```python
mesh = GeometryScript_MeshBooleans.apply_mesh_boolean(
    mesh, Transform(), tool_mesh, tool_transform,
    GeometryScriptBooleanOperation.SUBTRACT, GeometryScriptMeshBooleanOptions())
```

`Transform` 控制两份网格的相对位置，资产局部坐标不等于关卡 Actor 的位置。
`GeometryScriptMeshBooleanOptions`：`allow_empty_result`、`fill_holes`、
`simplify_output`、`simplify_planar_tolerance`。
这个函数只返回 mesh，**没有成功 outcome**。必须自己验证输入封闭、输出非空且封闭、
减法后体积确实减少，以及目标资产回读一致。该判断用于保留实体的挖洞任务。
输入不封闭时，遵守正文的停止条件；指明一个开放网格路径不等于接受不可靠布尔。
全部删除、曲面裁剪等目标需要另外确认合适方法，不能借此继续试算当前失败的实体布尔。

## 减面

```python
mesh = GeometryScript_MeshSimplification.apply_simplify_to_triangle_count(
    mesh, 100, GeometryScriptSimplifyMeshOptions())
```

`GeometryScriptSimplifyMeshOptions`：`method`、`allow_seam_collapse`、
`allow_seam_smoothing`、`allow_seam_splits`、`preserve_vertex_positions`、
`retain_quadric_memory`、`auto_compact`。
目标是三角形数。约束可能阻止继续减面，报告真实 before/after 与是否达到目标；
不要放宽接缝约束或重展 UV 只为了凑数。

## 均匀重网格

```python
mesh = GeometryScript_Remeshing.apply_uniform_remesh(
    mesh, GeometryScriptRemeshOptions(), GeometryScriptUniformRemeshOptions())
```

它有**两份** options，不能只传边长。

| 参数类型 | 字段 |
|---|---|
| `GeometryScriptUniformRemeshOptions` | `target_type`、`target_edge_length`、`target_triangle_count` |
| `GeometryScriptRemeshOptions` | `remesh_iterations`、`smoothing_rate`、`smoothing_type`、`reproject_to_input_mesh`、`discard_attributes`、`allow_splits`、`allow_collapses`、`allow_flips`、`mesh_boundary_constraint`、`group_boundary_constraint`、`material_boundary_constraint`、`prevent_normal_flips`、`prevent_tiny_triangles`、`use_full_remesh_passes`、`auto_compact` |

边长使用模型坐标单位。先读取尺寸和当前面数估算工作量；不为测试超时直接把
大网格边长设为 0.05。`discard_attributes` 会丢弃 UV 等属性，不能默认开启。

## 查询与判断

```python
triangles = mesh.get_triangle_count()
closed = GeometryScript_MeshQueries.get_is_closed_mesh(mesh)
surface_area, volume = GeometryScript_MeshQueries.get_mesh_volume_area(mesh)
```

体积返回顺序是 **面积、体积**。`closed` 只检查拓扑边界，不证明没有自交或法线正确。
不要把三角形数变化当作所有操作的成功条件。
把核对结果赋给 `output_data`，它会送回 Agent；失败时抛出明确异常并保留诊断输出。

## Nanite 与自动 LOD（不改 LOD0）

开关 Nanite 是网格的一个设置，不写 Python：`ue_content_set_properties`，
`{"NaniteSettings.bEnabled": true}`，关掉就恢复。LOD 组、碰撞复杂度
（`BodySetup.CollisionTraceFlag`）同理。

自动 LOD 也不写 Python，用 `mesh_optimize`：

```json
{"path": "/Game/Meshes/SM_Rock", "lods": {"count": 4}}
{"path": "/Game/Meshes/SM_Rock", "lods": {"count": 3, "reduction": [40, 15]}}
```

`reduction` 是 LOD1 起每级保留 LOD0 面数的百分比，省略时逐级减半。
网格有导入的 LOD 时这一项被拒绝；用户同意保留就加 `"keep_imported": true`，
只在导入的级后面追加。回执给每级前后面数和来源；生成的级面数没降会单独标 ⚠️。

## 布尔之后：碰撞与 LOD

对**副本**操作。碰撞按新几何做凸包分解（默认先删旧的简单碰撞）：

```json
{"path": "/Game/Meshes/SM_Wall_Holed", "collision": {"type": "convex", "hull_count": 8}}
```

凸包数太少时洞会被一个凸包盖住，适当加大再试（1–64，顶点上限 `max_hull_verts` 6–32）。

**导入的 LOD 换成生成的**：布尔之后导入的 LOD1+ 还是没洞的旧几何。只有用户明确同意
（换掉就回不来，撤销除外）才加 `replace_imported`，从 LOD1 起全部重建：

```json
{"path": "/Game/Meshes/SM_Wall_Holed", "lods": {"count": 4, "replace_imported": true}}
```

回执里会点名换掉了哪几级导入 LOD。`replace_imported` 和 `keep_imported` 互斥，同时给会被拒绝。

做完 `mesh_describe` 回读碰撞图元数和每级 LOD 来源；能不能走过去要在 PIE 里验证。
