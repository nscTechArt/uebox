# Unreal Agent Skill Standard

本规范用于统一 `resources/skills/` 下所有 skill 的结构、触发语义、按需加载方式和校验门槛。

规则分两类，文中会标出来：

- **[官方]** —— 来自 [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)，
  违反会导致加载失败或触发不稳定，不能商量。
- **[本仓库]** —— 我们自己加严的家规，理由写在条目里。

门禁：`pnpm verify:skills`（脚本 `scripts/check-skills.mjs`，已接入 `pnpm verify`）。
看每个 skill 的体检数据：`node scripts/check-skills.mjs --list`。

## 1. 目标

- 把 skill 从「一次性大提示词」收敛成「可触发、可复用、可验证」的工作流资产。
- 降低误触发、重叠触发和上下文膨胀。
- 让中文任务、中文文档和 Windows 路径在仓库内稳定工作。

**为什么要用脚本守而不是靠 review**：skill 坏掉不会报错。它只会悄悄不触发，或者被
Claude 只读到一半，在开发机上完全看不出来 —— 用户那边表现为「这个功能时灵时不灵」。

## 2. 标准目录结构

```text
your-skill-name/
├── SKILL.md
├── references/
│   ├── wiring.md
│   └── trigger-examples.md
├── scripts/
│   └── validate_case.py
└── assets/
    └── template.md
```

- 文件夹名必须使用 `kebab-case`。**[官方]**
- 主文件必须叫 `SKILL.md`。**[官方]**
- 文本文件统一 `UTF-8`，禁止 `UTF-8 BOM` —— 带 BOM 时 frontmatter 解析直接失败。**[本仓库]**
- **只允许 `references/`、`scripts/`、`assets/` 三个子目录。** 加载器
  ([SkillsService.ts](../../src/main/agent-v3/capabilities/skillsService/SkillsService.ts) 的
  `allowedRoots`) 只服务这三个，放别处的文件运行时读不到。**[本仓库]**
- 三个目录都按需创建，不是每个 skill 都要有。单文件 skill 只要正文不超标就是合规的。

## 3. Frontmatter 规范

```yaml
---
name: ue-blueprint-graph-editing
description: Build or modify logic inside an existing Blueprint … Use when the user wants behaviour added to a Blueprint … Do not use for creating the Blueprint asset itself, for material graphs, or for Sequencer.
---
```

硬限制（违反会被官方运行时拒绝）**[官方]**：

| 字段          | 限制                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `name`        | 必填；≤ **64 字符**；只能小写字母、数字、连字符；不能含保留词 `anthropic` / `claude`；不能含 XML 标签 |
| `description` | 必填非空；≤ **1024 字符**；不能含尖括号（会被当 XML 标签转义）                                        |

另外：`---` 必须是文件**第一行**，前面有空行或 BOM 会让整个文件被当成正文。**[官方]**

家规 **[本仓库]**：

- `name` 必须和文件夹名完全一致 —— 加载器按 `name` 查找，两边不一致时改名会漏改一处。
- 只写 `name` 和 `description` 两个字段。其他字段（`allowed-tools`、`license` 等）是
  Claude Code / 官方 API 的分发通道才认的，我们的加载器只解析这两个。

## 4. Description 写法

description 是唯一常驻上下文的部分，决定这个 skill 会不会被选中。

**必须第三人称** **[官方]**。「我可以帮你…」「你可以用它…」会影响触发判断：

- ✓ `Places, queries and deletes actors in the open level.`
- ✗ `I can help you place actors.` / `You can use this to place actors.`

推荐模板：

```text
<能力范围>. Use when the user asks for <典型请求1>、<典型请求2>. Do not use for <负向边界1> or <负向边界2>.
```

中文触发词可以直接混排在英文 description 里（现有 skill 就是这么写的）：

```text
… or says things like "接错线了改一下"、"全场景下雨"、"这个材质被谁用了". Do not use for Blueprint graphs …
```

硬要求：

- 必须有正向触发条件（`Use when …` / 「当用户…」）。**[官方]**
- 必须有负向边界（`Do not use for …` / 「不适用于…」）。**[本仓库：官方只是建议，
  但我们有 12 个高度重叠的 UE skill，没有负向边界就会互相抢触发。]**
- 应写用户的自然语言说法，不要只写领域名词。中文任务优先的 skill 要覆盖中文说法。
- 不要写成「帮助处理项目」「处理 Unreal 问题」这种空泛描述。

## 5. SKILL.md 正文结构

建议主文件只保留决策和执行骨架：

1. `Quick Start`
2. `Workflow`
3. `Constraints`
4. `Failure Handling`
5. `Escalation`

补充规则：

- 主文件负责给出最短决策路径，不负责堆完全部知识。
- **正文超过 500 行**就必须拆到 `references/`。**[官方]**
  （注意单位是**行**，不是词。以前这里写成「500 英文词」，比官方严了约 5 倍，
  会逼着把本来正常的 skill 拆碎。）
- 如果存在 `references/`、`scripts/`、`assets/`，正文必须显式提到里面的每个文件，
  否则 Claude 不会去读它 —— 门禁会把没被提到的资源文件报出来。

## 6. 何时拆 references

以下内容优先放进 `references/`：

- 详细触发样例、长 checklist、项目适配说明、模板
- 路由表、CSV、映射表
- 大段 API anchors 或领域知识

主文件里的写法：

- 需要项目差异化约束时，先看 `references/project-adapter.md`。
- 路由分流依据见 `references/trigger-examples.md`。

两条硬规则 **[官方]**：

- **引用只能一层深。** `SKILL.md → a.md → b.md` 里的 `b.md` 会被 Claude 用 `head -100`
  之类的方式半读，拿到不完整信息。所有 reference 必须从 SKILL.md 直接链。
- **reference 文件超过 100 行要在开头加「## 目录」/「## Contents」。** 同样是因为半读 ——
  有目录时 Claude 至少知道后面还有什么，可以决定要不要读全。

## 7. 何时加 scripts

以下情况优先脚本化，而不是只写自然语言：

- 可重复的校验、路由表生成、日志扫描、批量结构检查、报告/索引生成

要求：

- `SKILL.md` 必须说明脚本**什么时候运行、输入是什么、输出是什么**，并且明确是
  「执行它」还是「读它当参考」—— 官方指出这两者不说清楚，Claude 会猜错。
- 脚本命名直接表达用途，例如 `scan_output_log.py`、`generate_module_index_v2.py`。
- 脚本要**自己处理错误**，不要失败了丢给 Claude 收拾；常量要有注释说明取值理由。

## 8. 何时加 assets

文档模板、报告模板、Prompt 模板、固定表格骨架。

如果一个 skill 每次都要求同样输出格式，但模板写在正文里，就应该迁移到 `assets/`。

## 9. 内容写法（官方明确点名的坑）**[官方]**

- **不写时效性内容**。「2026 年 8 月之前用旧接口」这种迟早变错。要写历史信息就放
  「旧写法」小节，用 `<details>` 折叠。
- **术语前后统一**。一会儿「引脚」一会儿「pin」一会儿「接口」，会让指令更难被准确执行。
- **不要罗列多个方案**。给一个默认做法 + 一个逃生口，而不是「你可以用 A，也可以用 B、C、D」。
- **示例要具体**，不要抽象描述风格 —— 输入/输出配对比形容词有用得多。
- **skill 内部文件引用一律用正斜杠**（`references/a.md`），反斜杠在非 Windows 上失效。
  注意区分：正文里出现的 **UE 资产路径、用户机器上的 Windows 绝对路径**不受这条限制，
  那是内容不是文件引用。

## 10. 专业方法：验证、先轻后重、波及面、指标 **[本仓库]**

前面几节管的是 skill **能不能被加载、被读全**；这一节管的是**教给模型的做法对不对**。
格式全合规的 skill，照样可能教出外行做法，而且门禁查不出来：模型会照着做，用户只会觉得
盒子「不够专业」。2026-10 对 21 个 UE skill 的审计（`docs/技能方法论审计-2026-10-14.md`）
查出约 30 条缺陷，都落在下面四类里。

凡是会**改东西或下结论**的 skill，Workflow 里必须写清以下四件事。某件不适用就写一行
说明为什么（例如纯只读的 skill 没有波及面），不要省略不提。

**1. 做完怎么验证——在真正生效的状态下验证**

工具返回成功，不等于用户要的效果出现了。写明这个领域的专家用什么办法确认「真的成了」：

- 编译通过 → 重开 PIE，看行为变没变
- 静止姿势对了 → 播一段运动动画，看会不会滑步
- 渲染跑完 → 打开首帧和镜头切点帧看画面
- 导入成功 → 读回尺寸、碰撞、Nanite

工具验证不了的（例如联机复制），写明「模型自证不了，要请用户测什么、怎么测」，
不能默认当成已完成。

**2. 先轻后重——便宜、可撤回的办法放前面**

同一个问题有多种手段时，按成本和能否撤回排序：

只读查询 → 运行时开关或参数 → 改设置或实例 → 在副本上做破坏性操作 → 改原件

反例：

- 性能排查跳过运行时 ShowFlag 减法，直接复制关卡删资产
- 「面数太高」直接把 LOD0 减面，没先考虑 Nanite 或自动 LOD
- PCG 不先在小范围试跑，一上来全量铺满

涉及测量的 skill 还要写测量纪律：先预热，再重复测量看噪声，前后对比要交替跑，
改过的全局设置测完要还原。

**3. 波及面——改共享的东西前先查谁在用**

删除、改名、改签名、换父类、改全局参数之前，先查引用方；改完之后，也要确认引用方没坏。
只编译或只检查改动的那一处不算完。

**4. 指标——说清这个数到底量的是什么**

结论依据的数字要符合专家的口径，例如：

- 开了 Nanite 的网格，不能按原始面数判断开销
- 包体问题不能按 /Game 下的磁盘大小判断，内存问题按贴图内存排
- Message Log 不是输出日志
- MPC 是全局的，只想影响单个对象就不能用它

容易拿错尺子的地方，要在 skill 里点名写出来。

**怎么写出这四件事**：动笔前先列三栏对照——这个领域的资深从业者怎么做、我们打算让模型怎么做、
我们的工具实际能做到哪些（要去工具和插件代码里核实，不能凭印象）。三栏对不上的地方，
要么补进 skill，要么记成工具缺口。有条件时请资深用户评审，`ue-sequencer` 的
`references/red-lines.md` 就是这样来的，它也是审计里最扎实的一个 skill。

## 11. 中文适配要求 **[本仓库]**

- 所有 Markdown、YAML、Python 文本统一保存为 UTF-8，无 BOM。
- 中文标题、中文说明允许出现，但文件名保持 ASCII 和 `kebab-case`。
- 触发短语应尽量覆盖中文用户说法，不要只写英文关键词。
- Windows 绝对路径、Unreal 资产路径、中文自然语言可以同时出现在 skill 中，
  但表达要稳定、不要混乱缩写。

## 12. 测试要求

官方做法是**评测先行** **[官方]**：先在没有 skill 的情况下跑几个真实任务，记下 Claude
具体在哪失败，再照着写最小够用的指令 —— 而不是先写一大篇文档再想它解决了什么。

每个 skill 至少满足以下一项 **[本仓库]**：

- 在 `references/` 中提供 smoke prompts / trigger examples；
- 在 `scripts/` 中提供可执行的检查脚本；
- 在仓库文档中存在对应的触发测试和负例测试集合。

最低测试面：应触发的正例、不应触发的负例、边界模糊例、失败处理例。

触发测试只能证明 skill 会被选中，不能证明它教的做法对。§10 的四件事要靠评审来查。

## 13. 校验门槛

[scripts/check-skills.mjs](../../scripts/check-skills.mjs) 当前覆盖：

- `SKILL.md` 存在、无 BOM、frontmatter 在第一行
- `name`：与目录名一致、≤ 64 字符、kebab-case、无保留词
- `description`：非空、≤ 1024 字符、无尖括号、有触发条件、有负向边界、第三人称
- 正文 ≤ 500 行
- 只存在 `references/` `scripts/` `assets/` 三个子目录
- 正文引用的资源文件真实存在；存在的资源文件都被正文引用
- reference 之间不嵌套引用（只能一层深）
- reference 文件超过 100 行必须有目录
- skill 内部文件引用不使用反斜杠

另有一道守在测试里而不是这个脚本里：
[toolNameReferences.test.ts](../../src/main/agent-v3/tools/toolNameReferences.test.ts) —— 
**正文里写的工具名必须真的在注册表里**（顺带也查每个工具自己的描述和参数说明）。
它进不了 `check-skills.mjs`：那是纯 node 脚本，而工具注册表要 import electron 和
services，只有 vitest 环境里拿得到。

脚本查不了、只能靠 review 的：术语是否统一、示例是否具体、是否混入时效性内容、
`description` 的触发词是否真的覆盖用户说法，以及 §10 的四件事写没写、写得对不对。
最后这一项故意不放进门禁：靠关键词或标题去判断「方法对不对」，查出来的只会是
「标题写了没有」，而不是内容对不对。

## 14. 迁移优先级

1. 先补 `description`（触发精度问题先于知识密度问题 —— 触发不了，后面再完整也没用）
2. 再补 §10 的四件事（教错的做法比没教更糟，排在拆分和脚本之前）
3. 再拆 `references/`
4. 再补 `scripts/`
5. 最后补 `assets/`
