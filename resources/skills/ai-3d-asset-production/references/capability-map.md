# 能力与限制对照表

这份表里的限制来自实际适配器代码，不是推测。选错组合的后果分两种：**明确报错**
（浪费一次往返）和**静默忽略**（参数没生效，账照扣，要到进引擎才发现）。
后者更贵，所以下面把哪些是静默的单独标出来。

## Contents

- [generate_image](#generate_image)
- [generate_3d_model](#generate_3d_model)
- [三家 3D 厂商的实际差异](#三家-3d-厂商的实际差异)
- [Unreal 侧能做什么](#unreal-侧能做什么)
- [Blender 侧能做什么](#blender-侧能做什么)

## generate_image

| 参数 | 说明 |
| --- | --- |
| `prompt` | 必填。写画面本身：主体、材质、光线、镜头、风格 |
| `reference_images` | 本地绝对路径、http(s) 直链、data URI 三种都收。在提示词中按编号说明每张用途；当前 SiliconFlow 接入只发送单图，多图会在提交前报错 |
| `count` | 1–8，默认 1。张数直接乘在用户账单上 |
| `aspect_ratio` | 形如 `16:9` / `1:1` / `9:16` |
| `size` | 档位 `1K` / `2K` / `4K`，或像素 `1024x1024` |
| `seed` | 当前仅 SiliconFlow / Ark 接入传递；不能保证身份或构图一致。系列图和迭代应使用认可的参考图、重申保留项并逐张检查 |
| `model` | 可以只写片段。不填就用用户绑定给「生图」的那个 |

要点：

- 最多 **4 张**进模型上下文，其余照常存盘并在返回值里给路径。要看更多就分批。
- 出图存进素材库的 AIGC/图片，返回**绝对路径**，可以直接喂给
  `generate_3d_model` 的 `reference_images`，也可以 `ue_content_import` 进工程当贴图。
- `ue_screenshot` 返回值里的 `path` 可以直接放进 `reference_images`，
  白盒转概念图就靠这个（那条路有专门的 `ue-ai-render-from-blockout` skill）。

## generate_3d_model

| 参数 | 说明 |
| --- | --- |
| `prompt` | 与 `reference_images` 至少给一个。写物体本身，**别写镜头和光线** |
| `reference_images` | 同上三种来源。**多张都会用上**，按 `正面 → 左 → 背 → 右` 排，上限见下表 |
| `quality` | `high` / `medium` / `low` / `extra-low`，直接对应面数 |
| `topology` | `raw` = 三角面（直接进引擎），`quad` = 四边面（便于在 DCC 里继续改） |
| `format` | 默认 `glb`（单文件自带材质，虚幻导入器认它）。还有 gltf / fbx / obj / usdz / stl |
| `bounding_box` | `[宽, 高, 长]`，限制成品最大尺寸。**整批资产要比例一致时必填** |
| `material` | `pbr`（进引擎用这个）/ `shaded`（只有烘死光照的基础色）/ `all` |

**绑了 Tripo 时**入参表里还会多出下面这组（绑别家时它们根本不出现）：

| 参数 | 说明 |
| --- | --- |
| `negative_prompt` | 不想要的东西，几个词，上限 255 字。去底座 / 支架 / 背景板靠它 |
| `smart_low_poly` | 出「像手工做的」低模拓扑。**仅 H 系列**，面数会被压进 1000–20000 |
| `auto_size` | 按真实米制缩放。Tripo 没有 `bounding_box`，整批尺寸一致靠它 |
| `align_orientation` | 成品朝向对齐参考图。**仅 H 系列，且要有参考图** |
| `texture_alignment` | 贴图对齐原图还是对齐几何。**仅 H 系列，且要有参考图** |
| `image_autofix` | 先让厂商修一遍输入图，更慢。**仅 H 系列，且要有参考图** |
| `geometry_quality` | 几何精细档。**仅 H 系列**，`detailed` 最贵 |
| `texture_quality` | 贴图精细档。`extreme` **只有 P 系列**有 |
| `generate_parts` | 分件输出。**仅 H 系列**，出来**没有贴图**，与 `material`、四边面互斥 |

要点：

- **不返回模型进上下文**，没有能塞进上下文的形式。厂商附的那张预览渲染图会进上下文，
  它能判断主体对不对、风格对不对、大致形状对不对；**判断不了**拓扑、面数、朝向、
  穿模、尺寸。别拿它当「我看过模型了」。
- 出的是一个**新网格**，不是从工程里的资产改出来的。要减面、要 LOD、要重拓扑现有资产，
  那是引擎或 Blender 的事。
- 不给 `bounding_box` 时每个模型都是各自归一化的大小，导进引擎要一个个手调缩放。

## 三家 3D 厂商的实际差异

| | 多张参考图 | 纯文字生成 | `bounding_box` | 四边面 | 专属开关 |
| --- | --- | --- | --- | --- | --- |
| Rodin | **整组都发过去**，不卡张数 | 支持 | 支持 | 支持 | 无 |
| Tripo | **2–4 张走 multiview**（视位 = 正/左/背/右），第 5 张明确报错 | 支持 | 明确报错，改用 `auto_size` | 只有 H 系列有，且**只能导 fbx** | 上面那 9 个 |
| Meshy | **2–4 张走 multi-image**（1–4 张），第 5 张明确报错 | 明确拒绝，必须给参考图 | 明确报错 | 支持 | 无 |

**三家都真的吃多图**，所以四视图那一步在哪条路上都不白做。要注意的是另外两件事：

- **顺序即朝向：`正面 → 左 → 背 → 右`。** Tripo 是按视位收的，工具按这个顺序
  往四个视位里放；Meshy 收一个有序数组。**顺序错了不会报错**，出来的是一个
  左右颠倒的模型 —— 而那种错在预览渲染图上也看不出来。
- **Tripo 和 Meshy 各只有四个视位**，给第 5 张会明确报错（不是静默丢掉）。
  真有更多角度要喂，那是 Rodin 那条路。

Tripo 走多图时的其余限制与单图那条完全一样（`bounding_box` 仍然报错，
四边面仍然只有 H 系列且强制 fbx）—— 换端点不改变这些。

Meshy 的 `quality` 和 `topology` 在厂商侧默认是不生效的，工具已经替你打开了那一位，
不用额外传参。Tripo 的两个系列面数量级差很多，`quality` 的档位含义随系列变。

## Unreal 侧能做什么

几何编辑一律通过 `ue_run_python_script` 调 Geometry Script，没有专用工具。
详细做法见 `ue-geometry-editing` skill，这里只列它覆盖的范围：

- 布尔并集与差集、平面切割
- 简化减面、重网格（remesh）
- 补洞、焊接顶点
- UV 投影
- 生成碰撞
- 结果写回 Static Mesh 资产

读网格用 `mesh_describe`（面数、材质槽、包围盒、碰撞、UV 层）。

**驱动不了的**：交互式 Modeling Mode 里的雕刻、PolyEdit 这类工具没有脚本接口。
需要它们就得去 Blender。

## Blender 侧能做什么

通过官方 Blender Lab MCP，共 26 个工具。常用的几类：

- `execute_blender_code` —— 执行任意 Blender Python，返回值放进 `result`。
  它可能返回一个 MCP 成功信封里包着 `{"status":"error"}`，**两层都要检查**。
- `get_objects_summary` / `get_object_detail_summary` —— 读场景，动手前先读，别覆盖用户已有的东西。
- `search_api_docs` / `get_python_api_docs` / `search_manual_docs` —— 查 API。
  **写 bpy 代码前先查，不要凭记忆写。** 最常见的翻车是按名字找节点：
  中文界面下节点名是本地化的（Principled BSDF 显示成「原理化 BSDF」），
  按名字一定找不到，要按 `bl_idname` 之类的类型找。
- `render_viewport_to_path` / `render_thumbnail_to_path` —— 出图落盘。
- `get_screenshot_of_window_as_image` / `get_screenshot_of_area_as_image` —— 直接截视口。
  注意后台模式下截图工具用不了，那种情况改用渲染。

写文件时用用户文件访问范围内的路径，**不要往引擎安装目录里扔中间产物**。
