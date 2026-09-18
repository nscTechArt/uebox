# IK Rig / IK Retargeter 脚本接口

Python 名字是 C++ 名字的 snake_case。下表的可用性是在本机 UE 5.0–5.8 九个引擎上
逐版本核对头文件得到的，不是推测。

## 目录

- [版本可用性](#版本可用性)
- [IKRigController：建 rig、定义链](#ikrigcontroller建-rig定义链)
- [IKRetargeterController：挂 rig、映射链、调姿势](#ikretargetercontroller挂-rig映射链调姿势)
- [批量重定向](#批量重定向)
- [枚举](#枚举)
- [5.2 / 5.3 的手工链定义](#52--53-的手工链定义)

## 版本可用性

| | 5.0 | 5.1 | 5.2 | 5.3 | 5.4 | 5.5 | 5.6 | 5.7 | 5.8 |
|---|---|---|---|---|---|---|---|---|---|
| 两个控制器整体对脚本可见 | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `apply_auto_generated_retarget_definition` / `apply_auto_fbik` | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `auto_align_all_bones` | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `duplicate_and_retarget` | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 弃用 |
| `run_batch_retarget` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |

5.0 / 5.1 的 `UIKRetargeterController` 和 `UIKRigController` 一个 `UFUNCTION` 都没有，
Python 里这两个类不存在。整个 IKRig 插件在这两版里只有 `IKRigComponent` 和
`IKRigInterface` 对脚本可见，跟重定向配置无关。

一律用 `hasattr` 判断能力，不要按引擎版本号写分支。

## IKRigController：建 rig、定义链

`unreal.IKRigController.get_controller(ik_rig_definition)` 拿控制器。
资产用 `AssetToolsHelpers.get_asset_tools().create_asset(name, folder, unreal.IKRigDefinition, unreal.IKRigDefinitionFactory())` 建。

| 调用 | 返回 | 说明 |
|---|---|---|
| `set_skeletal_mesh(mesh)` | `bool` | 换骨骼网格会重置已有链，先读 `get_skeletal_mesh()` 比对 |
| `get_skeletal_mesh()` | `SkeletalMesh` | |
| `apply_auto_generated_retarget_definition()` | `bool` | 5.4+。相当于 UI 上的 Auto-Characterize，一次生成整套链和重定向根 |
| `apply_auto_fbik()` | `bool` | 5.4+。自动加 Full Body IK solver 和 goal |
| `add_retarget_chain(chain_name, start_bone, end_bone, goal_name)` | `Name` | 失败返回 `None`；**成功时返回的名字可能被改过**，见下 |
| `set_retarget_root(root_bone_name)` | `bool` | 通常是 `pelvis` / `Hips` 那根 |
| `get_retarget_chains()` | `Array[BoneChain]` | 元素读 `.chain_name` |
| `get_retarget_chain_start_bone(chain_name)` / `..._end_bone(...)` | `Name` | 回读用这两个，不要读 `BoneChain` 里的骨引用字段 |
| `set_retarget_chain_start_bone(chain_name, bone)` / `..._end_bone(...)` | `bool` | |
| `remove_retarget_chain(chain_name)` / `rename_retarget_chain(old, new)` | `bool` / `Name` | |
| `add_solver(solver_class)` / `add_new_goal(goal_name, bone_name)` / `connect_goal_to_solver(goal, solver_index)` | | 只有需要 IK（脚不打滑、手贴道具）时才用 |

**链名会被自动去重。** `add_retarget_chain` 内部走 `GetUniqueRetargetChainName`，
传 `Spine` 而资产里已有 `Spine` 时，实际加进去的是 `Spine_0` 之类。
**用返回值当链名**，不要假设就是你传进去的那个。

**骨名不存在时不抛异常**，只往 Output Log 打 Warning 并返回 `None`。必须检查返回值。

## IKRetargeterController：挂 rig、映射链、调姿势

`unreal.IKRetargeterController.get_controller(retargeter_asset)` 拿控制器。
资产用 `create_asset(name, folder, unreal.IKRetargeter, unreal.IKRetargetFactory())` 建。

| 调用 | 返回 | 说明 |
|---|---|---|
| `set_ik_rig(source_or_target, ik_rig)` | 无 | 无返回值，必须用 `get_ik_rig` 回读确认 |
| `get_ik_rig(source_or_target)` | `IKRigDefinition` | |
| `set_preview_mesh(source_or_target, mesh)` / `get_preview_mesh(...)` | | 只影响编辑器预览，不影响批量重定向结果 |
| `auto_map_chains(auto_map_type, force_remap)` | 无 | 无返回值也不报错，**必须逐条 `get_source_chain` 回读** |
| `set_source_chain(source_chain_name, target_chain_name)` | `bool` | 手工指定单条映射，参数顺序是「源在前、目标在后」 |
| `get_source_chain(target_chain_name)` | `Name` | 没映射时返回 `None` |
| `get_retarget_chain_settings(target_chain_name)` / `set_retarget_chain_settings(name, settings)` | `TargetChainSettings` / `bool` | 单链的旋转/平移/IK 开关 |
| `get_root_settings()` / `set_root_settings(settings)` | | 根骨的位移缩放，人物高矮差很多时调这里 |
| `auto_align_all_bones(source_or_target)` | 无 | 5.4+。先重置传入那一侧的重定向姿势，再整体对齐 |
| `create_retarget_pose(name, source_or_target)` / `set_current_retarget_pose(name, source_or_target)` | | 一个资产里可以存多套重定向姿势 |
| `set_rotation_offset_for_retarget_pose_bone(bone, rotation, source_or_target)` | | 逐骨写姿势偏移，5.2 / 5.3 手工对齐姿势只能用这个 |

## 批量重定向

5.2–5.7：

```python
created = unreal.IKRetargetBatchOperation.duplicate_and_retarget(
    assets_to_retarget,   # Array[AssetData]
    source_mesh, target_mesh, ik_retarget_asset,
    search='', replace='', prefix='', suffix='_Hero',
    include_referenced_assets=True)
```

5.8 起换成结构体入参（旧接口还在但已标弃用）：

```python
inputs = unreal.IKRetargetBatchOperationInputs()
inputs.assets_to_retarget = assets_to_retarget
inputs.source_mesh, inputs.target_mesh = source_mesh, target_mesh
inputs.ik_retarget_asset = ik_retarget_asset
inputs.suffix = '_Hero'
# 另有 target_path / use_source_path / overwrite_existing_files / retain_additive_flags
created = unreal.IKRetargetBatchOperation.run_batch_retarget(inputs)
```

两个都返回 `Array[AssetData]`，是新建出来的动画。用
`hasattr(unreal.IKRetargetBatchOperation, 'run_batch_retarget')` 分流。

## 枚举

| Python | 值 |
|---|---|
| `unreal.RetargetSourceOrTarget` | `SOURCE`（拷贝来源）、`TARGET`（拷贝目标） |
| `unreal.AutoMapChainType` | `EXACT`（只配完全同名，大小写不敏感）、`FUZZY`（按编辑距离配最近的）、`CLEAR`（全清空） |

## 5.2 / 5.3 的手工链定义

这两版没有 `apply_auto_generated_retarget_definition`，链要一条条加。
骨名换成目标骨架自己的，先用 `unreal.SkeletalMesh` 的骨骼列表确认名字存在。

```python
ctrl = unreal.IKRigController.get_controller(rig)
ctrl.set_skeletal_mesh(mesh)
if not ctrl.set_retarget_root('pelvis'):
    raise RuntimeError('重定向根设置失败，确认骨名')

wanted = [('Spine', 'spine_01', 'spine_03'),
          ('LeftArm', 'clavicle_l', 'hand_l'),
          ('RightArm', 'clavicle_r', 'hand_r'),
          ('LeftLeg', 'thigh_l', 'foot_l'),
          ('RightLeg', 'thigh_r', 'foot_r')]
added = {}
for name, start, end in wanted:
    actual = str(ctrl.add_retarget_chain(name, start, end, 'None'))
    if actual == 'None':
        raise RuntimeError('加链失败（骨名不存在）：%s %s-%s' % (name, start, end))
    added[name] = actual   # 可能被去重改名
```

源和目标两边的链名**取一致**，后面 `auto_map_chains(EXACT)` 才配得上；
命名对不上就只能逐条 `set_source_chain`。
