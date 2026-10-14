---
name: ue-geometry-editing
description: Edits mesh geometry itself inside Unreal using Geometry Script - boolean union and subtract, plane cuts, simplification, remeshing, hole filling, welding, UV projection, collision generation, and writing the result back to a Static Mesh asset. Use when a model has to be changed rather than configured, or when the user says things like "把这两个模型合并成一个"、"在这面墙上开个洞"、"面数太高帮我减一下"、"这模型有破面补一下"、"给它生成个碰撞". Do not use for reading or auditing a mesh (that is mesh_describe), for importing FBX, for moving or placing actors in the level, or for the interactive Modeling Mode tools such as sculpting and PolyEdit - those have no scripting interface and cannot be driven at all.
---

# Geometry editing (Geometry Script)

改几何本身通过 `ue_run_python_script` 调 Geometry Script。只改网格的设置（开关 Nanite、
碰撞复杂度、LOD 组）用 `ue_content_set_properties`；自动生成 LOD、生成简单碰撞
（盒 / 球 / 胶囊 / 凸包分解）用 `mesh_optimize`。这两类都不写 Python。

## Quick start

```
1. 确认 GeometryScripting 插件已启用（见下）
2. mesh_describe 看清楚现状
3. ue_run_python_script 跑一段「读进来 → 改 → 写入副本 → 从副本重新读取」
4. 检查读写 outcome、操作目标和回读统计
5. ue_save，确认保存结果；要验证持久化时重开编辑器再回读
```

## 第一步永远是插件检查

GeometryScripting **默认不启用**。没启用时 `unreal.GeometryScript_*` 全部
`AttributeError`，看起来像 API 名字写错了。

```python
import unreal
output_data = {'geometry_scripting_available': hasattr(unreal, 'GeometryScript_MeshBooleans')}
```

返回 `False` 就用 `ue_manage_plugin` 启用 `GeometryScripting`，
然后**必须重启编辑器**才生效：先 `ue_save`，再调 `ue_restart_editor`（它会等编辑器回来并重连），
别在没重启的情况下反复重试。

## 「面数太高」先别动 LOD0

用户说「面数太高帮我减一下」，要的通常是「别那么卡」，不是「把模型改坏一点」。按从轻到重走：

1. `mesh_describe`：Nanite 开没开、有几级 LOD、每级是导入的还是引擎生成的。
2. **开 Nanite**：静态网格、材质不透明时首选。几何一点不改，随时能关。
   半透明材质不走 Nanite；遮罩和 WPO 材质 5.0 不支持（5.1 起支持，但更贵）；
   目标平台不支持 Nanite（如移动端）时走第 3 步。
3. **自动生成 LOD**：LOD0 原样保留，远处换低模。已有导入的 LOD 时 `mesh_optimize` 会拒绝，
   先问用户：同意保留就传 `keep_imported: true` 只在后面追加；要换掉它们见下面「布尔之后」第 3 步。
4. 只有用户明确要 LOD0 本身变少（导出给别的软件、移动端最高档、做碰撞代理），
   才在副本上减面，走下面的标准往返。

第 2 步用 `ue_content_set_properties`，`{"NaniteSettings.bEnabled": true}`，回执带读回值；
第 3 步用 `mesh_optimize`，`{"lods": {"count": 4}}`（默认逐级减半），回执给每级前后面数。
它们改的是原资产本身，摆了它的每个关卡都跟着变：先用 `ue_content_dependencies`
（`direction: "referencers"`）看有多少地方在用，告诉用户。
做完用 `mesh_describe` 回读开关和每级面数，再 `ue_screenshot` 看近景有没有破形。
开了 Nanite 之后别再拿原始面数说它「太重」：Nanite 的开销看材质（遮罩、WPO）和重叠，不看面数。

## 标准往返

**优化已有资产时保留它的设置：** 减面、修补和另存修改版，默认先
`EditorAssetLibrary.duplicate_asset`，再把几何写入副本。
不要用 `create_new_static_mesh_asset_from_mesh` 建空白资产代替复制原资产，
否则材质槽、碰撞和光照设置会丢失。新建 API 留给没有来源资产的程序化模型。
把原件与副本的材质槽、碰撞、LOD 和光照设置一起对照；几何变了以后碰撞是否仍适合
需要另外核实，但不能未经要求把原有碰撞清空或把材质换成默认网格材质。

**布尔的停止条件先于操作：** 只要实际读取的任一输入 `closed=False`，
就先停下：**不调用布尔、不写入、不保存**。告诉用户「输入不封闭，实体布尔的结果
不可靠」，说清会坏在哪里（可能出现破面、缺面或内外翻转），并给出加厚/修补或改用切割的方案。
用户点名 Plane 只是指定输入，不等于已经接受不可靠结果，也不等于同意把平面变成立体，
所以要单独问。用户听完风险仍要照原样做，就在副本上做，做完如实回读并报告
`closed` 和破面情况，不把它说成可靠结果。

先读 [references/api.md](references/api.md) 的签名、返回值和参数说明。
以下示例是**减法布尔并另存副本**。替换三个资产路径，并按目标位置设置刀具变换。
它只证明几何回读通过；材质、UV、碰撞和视觉效果仍需按任务检查。

```python
import unreal, math

if not hasattr(unreal, 'GeometryScript_MeshBooleans'):
    raise RuntimeError('GeometryScripting 未启用；启用插件后必须重启编辑器')

source_path = '/Game/Meshes/SM_Wall'
tool_path = '/Game/Meshes/SM_DoorHole'
destination_path = '/Game/Meshes/SM_Wall_Holed'
if not destination_path.startswith('/Game/') or unreal.EditorAssetLibrary.does_asset_exist(destination_path):
    raise RuntimeError('目标必须是 /Game 下尚不存在的资产；不覆盖原件')

def read_mesh(asset):
    if not isinstance(asset, unreal.StaticMesh):
        raise RuntimeError('输入不是有效的 StaticMesh 资产')
    mesh, outcome = unreal.GeometryScript_AssetUtils.copy_mesh_from_static_mesh(
        asset, unreal.DynamicMesh(), unreal.GeometryScriptCopyMeshFromAssetOptions(),
        unreal.GeometryScriptMeshReadLOD(lod_type=unreal.GeometryScriptLODType.SOURCE_MODEL, lod_index=0))
    if outcome != unreal.GeometryScriptOutcomePins.SUCCESS or mesh.get_triangle_count() == 0:
        raise RuntimeError('读取网格失败：' + str(outcome))
    return mesh

def stats(mesh):
    area, volume = unreal.GeometryScript_MeshQueries.get_mesh_volume_area(mesh)
    return {'triangles': mesh.get_triangle_count(), 'volume': volume,
            'closed': unreal.GeometryScript_MeshQueries.get_is_closed_mesh(mesh)}

source = unreal.load_asset(source_path)
mesh = read_mesh(source)
tool = read_mesh(unreal.load_asset(tool_path))
before = stats(mesh)
if not before['closed'] or not stats(tool)['closed']:
    raise RuntimeError('输入网格不封闭，布尔结果不可靠；未写入资产。先确认修补方案')

unreal.GeometryScript_MeshBooleans.apply_mesh_boolean(
    mesh, unreal.Transform(), tool, unreal.Transform(),
    unreal.GeometryScriptBooleanOperation.SUBTRACT,
    unreal.GeometryScriptMeshBooleanOptions())
after = stats(mesh)
print({'before': before, 'after': after})
if (not after['closed'] or after['triangles'] == 0 or
        not 0 < after['volume'] < before['volume'] or
        math.isclose(after['volume'], before['volume'], rel_tol=1e-6)):
    raise RuntimeError('未确认有效的减法布尔结果；未写入资产')

# 加工和检查通过后才创建副本，保留原件及其材质槽配置。
destination = unreal.EditorAssetLibrary.duplicate_asset(source_path, destination_path)
if destination is None:
    raise RuntimeError('创建副本失败')
_, outcome = unreal.GeometryScript_AssetUtils.copy_mesh_to_static_mesh(
    mesh, destination, unreal.GeometryScriptCopyMeshToAssetOptions(),
    unreal.GeometryScriptMeshWriteLOD(lod_index=0))
if outcome != unreal.GeometryScriptOutcomePins.SUCCESS:
    raise RuntimeError('写入失败：' + str(outcome))

# 新建 DynamicMesh 从目标资产读；不能拿刚加工的 mesh 冒充回读。
readback = stats(read_mesh(destination))
if (not readback['closed'] or readback['triangles'] != after['triangles'] or
        not math.isclose(readback['volume'], after['volume'], rel_tol=1e-5)):
    raise RuntimeError('目标资产回读不一致，不能报告完成')
output_data = {'before': before, 'after': after, 'readback': readback,
               'destination': destination_path, 'geometry_verified': True,
               'save_required': True}
```

**副本沿用原件的碰撞和导入的 LOD。** 上面只改了 LOD0 的几何：原件的简单碰撞（常见是一个
包住整面墙的盒子）原样留着，门洞走不过去；导入的 LOD1+ 还是没洞的旧几何，走远一点洞就消失。
引擎自动生成的 LOD 会按新 LOD0 重建，导入的不会。布尔、平面切割之后，在副本上：

1. `mesh_describe` 看碰撞图元和每级 LOD 的来源。
2. 按新几何重做碰撞：`mesh_optimize`，`{"collision": {"type": "convex", "hull_count": 8}}`，
   默认先删掉旧的简单碰撞。凸包仍把洞封住就加大 `hull_count`；还不行时用
   `ue_content_set_properties` 把 `BodySetup.CollisionTraceFlag` 设成 `CTF_UseComplexAsSimple`
   （网格编辑器里的「Use Complex Collision As Simple」）。
3. 生成的 LOD 会按新 LOD0 自己重建；导入的 LOD 还是旧几何（走远一点洞就消失）。
   告诉用户这几级要换掉、换掉就回不来，**用户明确同意之后**才用 `mesh_optimize`
   `{"lods": {"count": 4, "replace_imported": true}}`，从 LOD1 起全部重建；
   回执会点名换掉了哪几级。用户没表态就停在这里问，不替他决定。
4. 回读确认，然后验证门洞真的能过：PIE 里让角色走过去（`ue_autoplay` 的 goal 模式把
   `reach_location` 设在洞的另一侧；它是实验性的，走不到先怀疑地形），或请用户走一趟。
   模型自己确认不了就照实说。

写回只改内存里的资产，**最后必须 `ue_save`**。
`ue_save` 的成功是保存回执；随后在同一编辑器里 `load_asset` 或 `mesh_describe`
通常仍读内存缓存，不能称为「从磁盘重新读取」。需要持久化验收时，另启编辑器进程后回读。

## 常用函数（类名就是 Python 里的名字）

| 要干的事 | 调用 |
|---|---|
| 合并 / 挖洞 / 求交 | `GeometryScript_MeshBooleans.apply_mesh_boolean` (UNION / SUBTRACT / INTERSECTION) |
| 平面切开 | `GeometryScript_MeshBooleans.apply_mesh_plane_cut` |
| 镜像 | `GeometryScript_MeshBooleans.apply_mesh_mirror` |
| 减面到指定面数（先看「面数太高」一节） | `GeometryScript_MeshSimplification.apply_simplify_to_triangle_count` |
| 减面到误差容限 | `GeometryScript_MeshSimplification.apply_simplify_to_tolerance` |
| 均匀重网格 | `GeometryScript_Remeshing.apply_uniform_remesh` |
| 体素封边 / 加壳 | `GeometryScript_MeshVoxelProcessing.apply_mesh_solidify` / `apply_mesh_morphology` |
| 补洞 | `GeometryScript_MeshRepair.fill_all_mesh_holes` |
| 焊接重合顶点 | `GeometryScript_MeshRepair.weld_mesh_edges` |
| 修退化面 | `GeometryScript_MeshRepair.repair_mesh_degenerate_geometry` |
| 重算法线 | `GeometryScript_Normals.recompute_normals` |
| 自动展 UV | `GeometryScript_UVs.auto_generate_x_atlas_mesh_uvs` |
| 按自定义形状生成碰撞（盒 / 球 / 胶囊 / 凸包分解用 `mesh_optimize`） | `GeometryScript_Collision.set_static_mesh_collision_from_mesh` |
| 读统计 | `GeometryScript_MeshQueries.get_mesh_info_string` / `get_is_closed_mesh` |
| 存成新资产 | `GeometryScript_NewAssetUtils.create_new_static_mesh_asset_from_mesh` |

不确定参数时用 `help(unreal.GeometryScript_MeshBooleans.apply_mesh_boolean)`
打出真实签名，别猜。

## 五个会咬人的地方

**面数不在 MeshQueries 上。** `GeometryScript_MeshQueries.get_triangle_count`
不存在（引擎里那行是注释掉的）。面数在 mesh 对象自己身上：`mesh.get_triangle_count()`。

**布尔之前先确认封闭。** `get_is_closed_mesh` 返回 `False` 时结果不可靠，
而引擎可能**不报错**。停止写入并说明原因，不要自行把 Plane 补成另一种模型。
封闭也不保证没有自交，仍要检查操作结果。只有用户要求修补时才补洞并重新检查。

**不要用 `copy_mesh_from_static_mesh_v2`。** 它只有 UE 5.5+ 有。
不带 `_v2` 的那个九个版本都在，5.5+ 里就是转发到 V2 的包装，功能一样。

**减面之后检查 UV。** 是否保留接缝取决于简化方法和参数。不要自动重展已有 UV，
那会改变贴图对应关系；先检查失真，再按用户需求处理 UV、LOD 和光照。

**先保留原件。** `copy_mesh_to_static_mesh` 会改目标资产；不要依赖撤销作为备份。
默认另存副本，只有用户明确要求时才覆盖。新建网格的材质槽和碰撞也需要检查。

## Failure handling

- **`AttributeError: module 'unreal' has no attribute 'GeometryScript_...'`** —— 插件没启用或没重启。
- **脚本跑很久没回来** —— 正常。执行是同步的，编辑器在这期间就是卡住的，上限 5 分钟。
  这是调用方等待上限，超时或停止等待不等于 UE 停止执行。先回读，别中途重发。
- **改完面数没变** —— 单凭面数不能判断：变换、法线和 UV 编辑本来就可能不改面数。
  减面看目标面数，减法布尔看封闭性与体积减少，UV/法线看对应数据与效果。
  证据不足就说「未确认」，不能凭脚本没抛异常报告完成。

## Escalation

雕刻、手动 PolyEdit、CubeGrid 这些建模模式里的交互式工具**够不着**：
引擎没给它们任何脚本接口，只吃鼠标输入。碰到这类需求直接告诉用户要手工做，
别用 Python 硬凑一个近似的。
