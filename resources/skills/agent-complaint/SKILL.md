---
name: agent-complaint
description: Turns friction from a just-finished task into a defect report the developer can act on — what got stuck, what it cost to work around, which tool was too narrow, and what capability is missing. The report is written to a file the user can hand over or paste into an issue. Use when a task just ended and something genuinely got in the way (a tool could not express what was needed, one small change took five calls, an error said only that it failed), or when the user says "抱怨一下"、"刚才哪儿别扭"、"这次有什么问题"、"记下来提给开发者". Do not use for summarising a task that went fine, for mistakes a stronger model would not have made, for blaming the engine or the project for something never actually diagnosed, for cases where the fix is just writing the steps down properly, or for sending or posting anything on the user's behalf.
---

# 抱怨：把这次的卡点写成开发者能改的东西

这条 skill 的产物不是情绪，是一份**别人在别处能看懂**的缺陷记录。读它的人是开发者，
他没有这次会话、看不到工具返回、也无法追问 —— 所有能证明问题的东西都得抄进文件里。

## 什么时候开口

任务已经交付完，再回头看这一趟。两个入口：

- **用户开口**：「抱怨一下」「刚才哪儿别扭」「这次有什么问题」→ 直接展开。
- **自己提议**：这一趟确实卡过，在交付的最后加**一行**：
  「这次有 3 处卡了：改控件类型没有那个取值、旋转回读只给数字、导入要分四步。
  要我记下来提给开发者吗？」

那一行只列标题，不展开。用户说要，才做后面的事；用户没理，就翻篇，不追问第二次。

**任务顺利就闭嘴。** 没卡过还硬提一句，下一次真卡了那句话就没人看了。

## 判据：这条值不值得记

一条一条过下面这关，问自己：

> **换一个更强的模型，这个错还会不会发生？**

- **还会** → 工具或工作流的缺口，记。
- **不会** → 是我这次没做好，不记成工具缺陷。别把自己的失误寄存到开发者的清单上，
  那会让工具越加越肥，而真问题被埋掉。

这条判据有一个例外，必须认出来：**工具让任何模型都在盲飞**的情况。回读只给裸数据、
没有任何语义（回一个 `Pitch: -37.5`，看不出灯是朝上还是朝下），换谁来都得猜 ——
这不是模型的问题，是真缺口。

其余不记的：一次没能复现的偶发；引擎本身的行为；用户工程里的脏数据；
文档写得不合我口味；我想出来但这次没真撞上的边界。

一次任务**最多记 5 条**，按「修好之后能省下多少次往返」排序。全都记等于没记。

## 六类真缺口

分类只是为了让开发者一眼知道该动哪儿。判断某条属于哪类、每类长什么样、
写得好和写得没用的对照，看 `references/defect-types.md`。

| 类别 | 一句话形态 |
|---|---|
| 工具比后端窄 | 引擎那边能做，工具的参数里表达不出来（枚举缺取值、参数没暴露、整条能力没工具） |
| 回读没有语义 | 数字回来了，但看不出对不对 |
| 关键信息拿不到 | 正文说「完整列表见 details」，而 details 我读不到；或者被截断了 |
| 一步变三步 | 用户嘴里的一件小事，要来回四五次工具调用 |
| 报错不可行动 | 只说失败，不说为什么、也不说下一步该试什么 |
| 审批节奏错 | 该拦的没拦，不该拦的每次都拦 |

## 每条必须带证据

「这个工具不好用」对开发者没有任何价值。每条至少写清：

1. 我当时想做什么（用户的原话最好）；
2. 我调了哪个工具、传了什么关键参数；
3. 它返回了什么 —— **抄原话**，不要转述；
4. 我最后怎么绕过去的，多花了几次往返；没绕过去就写没做成。

**不要写猜的根因。** 「因为插件里没实现 XXX」这种话，除非真的读过 `plugin/` 下的源码，
否则一律放进报告最后那节「猜测」里，并且标明没核实过。错的根因比没有根因贵：
开发者会照着它去改，防线守在错的地方，问题还在。

同理，我判断这是工具问题还是我自己的问题，也要**写成判断而不是结论** ——
开发者要的是依据，他自己会下结论。

## 写在哪

一次抱怨一个文件，方便用户直接拿一份去提一个 issue。

1. 先 `ue_get_project_info` 拿 `projectPath`、`engineVersion`、`pluginBuild`；
2. 写到 `<projectPath>/AgentFeedback/YYYY-MM-DD-短标题.md`，日期用系统提示词里的今天；
3. 用 `list_local_dir` 看一眼这个目录已经有什么，重名就换标题，不要覆盖旧的；
4. 用 `write_local_file` 写。它每次都会请求用户确认，这是正常的。

引擎没连、拿不到工程路径时，**问用户写哪儿**，不要猜一个路径。也不要往盒子自己的
数据目录里写（`AppData/Roaming/Unreal Box` 那一层）—— 那里除了 `skills/` 和素材库全被
挡着，会退回一句「这个位置存放的是凭据」，而那跟这件事毫无关系。

文件内容照 `assets/feedback-report.md` 填。那个模板里的每一节都要有内容，
没有的那节直接删掉，不要留着空标题。

## 交给用户

写完只说三句：文件在哪、里面几条各是什么、可以直接发给开发者或贴成一个 issue
（盒子的「关于」页里有 GitHub 入口）。

**不替用户提交。** 这条 skill 只写本地文件，不联网、不发消息、不建 issue。

报告里也不要出现密钥路径、账号、用户的私人目录结构 —— 提交出去的东西是公开的。

## 和「沉淀技能」的分工

两条 skill 都在任务结束后回头看，但看的不是一件事：

- 卡点的解法是**把正确步骤写清楚**，下次照着做就不会卡 → 那是 `ue-skill-creator` 的活，
  改 skill，不占开发者的清单。
- 卡点是**照着做也做不到**，得改代码才行 → 这条 skill，写反馈文件。

拿不准就按这个分：如果我现在能把「下次该怎么做」讲明白，那它就不是缺陷。

## Coverage

- **Verified**：无。这条 skill 刚写出来，还没在真机任务里跑过一次。
- **Not tried**：引擎未连接时的问路径分支；同一天写第二份报告时的重名处理；
  用户把目录指到工程外面的情况。
