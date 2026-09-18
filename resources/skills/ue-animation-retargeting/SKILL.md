---
name: ue-animation-retargeting
description: Retargets body animation between skeletons, measures poses and previews results in Unreal. Use when 用户说「这批动画换个骨架」「把动画重定向到角色」「手臂穿模」「量一下低头角度」「把这段改成固定姿势」. Do not use for FBX import, Level Sequence camera tracks, Control Rig authoring, or mesh geometry editing.
---

# Body animation: measure, retarget, preview

## Quick start

1. `anim_measure(path, describe=true)` 查动画帧率、帧数、骨轨道。
2. 已有调好的 IK Retargeter 就把路径传给 `anim_retarget.retargeter`；不要重新建 Rig 或自动对齐它。
3. 没有配置时，由 `anim_retarget` 自动建源/目标 Rig、严格同名映射和姿势对齐。
4. 批量传 `animations: [{ animation, output_path }]`，插件每次只导出一段，保存并回读骨架、关键帧和文件。
5. 对本次产物调用 `anim_measure`，再用 `anim_preview` 看同一时刻，回复给一张图加本轮数字。

首版在 UE 5.5 编译和验收。旧插件不认识 `anim.*` 时先更新插件；低于 5.5 返回不支持，不能反复调用。
5.2–5.4 尚未被新工具替代的脚本接口保留在 [references/api.md](references/api.md)。
测量口径、写姿势边界和会话教训见 [references/measurement.md](references/measurement.md)。

## 链映射与姿势判断

一条链都没映射上必须停，不导出废动画。返回的映射表和未映射链要检查：未映射的肢体不算完成。
自动匹配采用 EXACT，不偷偷退到模糊匹配；FUZZY 可能把名字相近、含义不同的骨链配到一起。

源 A-pose、目标 T-pose 不一致时，生成成功和帧数正确不能证明姿势正确。
新建配置会自动对齐，但仍须看预览；肩塌、手穿身先查姿势和链，别靠调参数掩盖问题。
现有配置保留用户的 Rig 和姿势。需要检查或修正时用 [接口参考](references/api.md) 的控制器读写，
修好后再传同一 retargeter 路径导出，不能用一次自动创建覆盖它。

链只负责骨骼对应；脚不滑、手贴住道具还需要 IK goal/solver。自动生成不代表这些约束已经满足。

## 写姿势

`anim_write_pose` 只在同一骨架的非叠加序列间复制姿势。主区间是闭区间，过渡帧在前后。
工具核对全部局部变换；七个摘要数字一致不能证明手腕、手指等全部写对。
缺轨道按参考姿势补齐，写入和过渡范围外保持原关键帧。

## Failure handling

- 输出已存在：先回读，再复用配置或另选新输出路径；工具不覆盖原件。
- 自动建链失败：检查骨架是否支持自动识别，已有手工配置就显式传入。
- 保存失败：可能已经改了内存，不要按“什么都没发生”重试。
- 超时或停止：停止只是当前这段完成后不发下一段；先回读已产生的资产。
- `unmeasurable`：报告缺骨或固定朝向限制，不能当作 0 或通过。
- 动画能播但姿势歪：先查重定向姿势，再查链映射，最后才查参数。
