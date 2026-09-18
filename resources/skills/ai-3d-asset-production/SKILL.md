---
name: ai-3d-asset-production
description: Routes a request for a new 3D asset across the box's AI and DCC capabilities instead of hand-modelling it - image generation for concept sheets, turnaround views and textures, image-to-3D generation for the base mesh, Unreal Geometry Script for simple cleanup, Blender for complex reshaping and small models - and checks each stage against the reference before the next one starts. Use when the user wants a model made from an idea or a reference picture, or says things like 照着这张图做个模型、做个道具、生成一个底模、先出四视图、用 AI 做这个资产、这模型做得不像怎么办. Do not use for editing an existing Unreal asset only, for skeletal characters, rigging or animation, for scattering or placing actors, or for concept art that will never become a model.
---

# AI 主导的 3D 资产生产

这条流程的前提是**AI 贯穿始终**：凡是已经接进盒子的 AI 能力，优先用它，手工只在
AI 这一环确实做不到时才补位 —— 不是反过来。

这里给的是**默认路线和判断依据，不是强制流程**。用户点名要某个模型、某条路、
某种做法，就照用户的来；下面的默认只在没人点名时生效。

## Quick Start

```
想法 / 参考图
  ↓  generate_image            设定图 → 四视图 → 贴图
  ↓  generate_3d_model         底模（静态网格，没有骨骼）
  ↓  ue_content_import         进工程
  ↓  简单优化 → Unreal          减面、补洞、碰撞、UV、布尔（skill: ue-geometry-editing）
  ↓  复杂优化 → Blender         造型、拓扑、细节、雕刻（skill: blender-ue-pipeline）
```

动手前先做两件事，顺序不能换：

1. **看参考图，写验收清单。** 照 [assets/asset-plan.example.json](assets/asset-plan.example.json)
   写一份，把决定「这是什么东西」的特征标 `critical: true`。奶牛的斑纹和角是 critical，
   奶瓶上的字不是。清单先写死，后面每一段都对着它验。
2. **确认这一段该谁做。** 见下面的路由表。选错工具比做得糙代价大得多 ——
   用错工具通常要整段重来。

## 路由表

| 要做的东西 | 默认用 | 为什么是它 |
| --- | --- | --- |
| 设定图、概念图、风格探索 | `generate_image` | 迭代最快，改一版几十秒 |
| 四视图 / 转身图 | `generate_image` + `reference_images` + 明确保留项 | 图生 3D 的原生输入形态，逐张核对一致性 |
| 颜色贴图、法线参考、材质纹理 | `generate_image` | 贴图本来就是二维问题 |
| 底模、blockout | `generate_3d_model` | 比脚本堆基本体强一个量级 |
| 减面、补洞、焊点、布尔、UV 投影、生成碰撞 | `ue_run_python_script` 走 Geometry Script | 不出引擎，链路最短 |
| 改造型、改拓扑、加结构细节、雕刻 | Blender | 引擎里没有对应能力 |
| 从零做**简单**模型（箱体、管件、旋转体、规则构件） | Blender | 参数化几步就到位，比生成更可控 |
| 从零手搓**复杂有机**造型 | 默认不做 | 见下面「已知会失败的做法」 |

拿不准「简单还是复杂」时的判据：**能不能用轮廓挤出、旋转、阵列、倒角、镜像
这几步说清楚**。能，就是简单模型，Blender 直接做；说不清，就是复杂造型，走生成 + 精修。

## Workflow

1. **读参考图，写 `asset-plan.json`。** 分开记录三件事：看得见的观察、用户明确的要求、
   推断出来的隐藏结构。标清哪些特征是 critical。参考图存进工作目录并记下路径。
2. **补齐视图。** 只有一张参考图时，先用 `generate_image` 补出四视图再去生成。
   一致性怎么保证见 [references/four-view-consistency.md](references/four-view-consistency.md)。
   出图时就按输入图标准写提示词（纯色背景、均匀光、无阴影、物体完整入画）——
   标准见 [references/prompt-and-params.md](references/prompt-and-params.md)。
   用户只给了一张、也不想多花这一步的，直接单图生成也行，但要告诉用户背面是模型猜的。
3. **生成底模。** `generate_3d_model`。提示词怎么写、`quality` 怎么按用途选、
   多视图和种子怎么用，见 [references/prompt-and-params.md](references/prompt-and-params.md) ——
   **生成结果差八成是输入差**，不要一律选 high 了事。各家厂商真正支持哪些参数见
   [references/capability-map.md](references/capability-map.md) —— 那份表里的限制是**实测过的**，
   不是猜的，选错组合会直接报错或者被静默忽略。
4. **验收第一次。** 拿生成结果的多角度视图对着清单逐条打勾。**只许说「第 3 条缺」，
   不许说「挺接近的」。** 底模阶段只验形和比例，不验拓扑和细节 —— 那是后面的事。
5. **决定优化走哪条。** 按路由表分流。进 Blender 就切到 `blender-ue-pipeline` skill，
   它带着自己的质量契约和回传校验，不要在这里另起一套。
6. **进引擎、验收第二次。** `ue_content_import` 之后用 `mesh_describe` 读回面数、
   材质槽、包围盒、碰撞，和计划里的预算对一遍。

## Constraints

- **图生 3D 出的一律是静态网格，没有骨骼。** 再好看也不能直接做动画。
  用户要可动画角色，说清这条流程给不了，别拿 T-pose 选项冒充带绑定。
- **生成器出的拓扑不是成品拓扑。** 缺动画要的边环，背景件够用，主角要重拓扑。
  把底模当 blockout 看待。
- **一张预览渲染图不能代替看模型。** 拓扑、面数、朝向、穿模，图上一样都看不出来。
- **多参考图的顺序就是朝向：`正面 → 左 → 背 → 右`。** 三家都真的吃整组图，
  但顺序错了不报错 —— 出来的是一个左右颠倒的模型。只给两张时它们被当成
  「正面 + 左」，所以手上只有正面和背面时要么补齐四张、要么只传正面那一张。
  张数上限见 capability-map。
- **面数和尺寸在生成时就要定。** 进引擎之后再返工是整段重做。
  整批资产要比例一致时，`bounding_box` 必须给（且只有支持它的厂商能给）。
- 生成会把参考图传到用户配置的外部厂商。这是把内容发出去，动手前让用户知道。

## 已知会失败的做法

**不要用 Blender Python 摆一堆基本体去拼有机造型。** 这是实测过的失败模式：
球和方块拼出来的东西各部件互不相连，轮廓、体积和衔接都对不上，越调越偏，
最后交出去的是个「像是那个东西」的替身。真要在 Blender 里手做圆润造型，
正路是 Metaball 或 Skin 修改器搭骨架 → 转网格 → 细分或体素重构 → 雕刻。

**不要跟自己的上一版比。** 每一轮都要对着**原始参考图**逐条验。
「比上一版好」和「符合要求」是两件事，把前者说成后者就是虚报。

## Failure Handling

- **同一个缺陷连续三次没修好，停下来换方法。** 不要试第四次。这时候要怀疑的是
  表示方法选错了（该生成的去手搓了、该重拓扑的在调参数），或者输入不够
  （缺视图、缺尺寸、缺材质说明）。如实报告差距，不许悄悄降低要求。
- **验收不过就不要往下一段送。** 底模形不对，进引擎减面和进 Blender 精修都救不回来。
  修最早出问题的那一段。
- **厂商任务超时不等于失败。** 状态未知时先查任务，不要盲目重交 —— 重交是再付一次全款。
- **工具报了 success 不等于事情成了。** 回读校验过才算。读不回来就说「没确认上」。

## Escalation

以下情况超出这条流程，要换路或者问用户：

- 要可动画的角色、骨骼、毛发、布料 —— 这条流程只做静态网格。
- 要改工程里已有资产的几何，而不是做新的 —— 直接走 `ue-geometry-editing`
  或 `blender-ue-pipeline`，不要绕这一整条。
- 用户一个 3D 生成 Provider 都没配 —— 告诉用户到 偏好设置 → AI → 模型来源 加一个，
  然后问是先配还是改走 Blender 手做。
- 参考图本身信息不足（只有正面、看不出厚度、关键结构被遮住）—— 说清哪一处推断不了，
  让用户补图或者接受推断结果，不要闷头猜完当成事实。
