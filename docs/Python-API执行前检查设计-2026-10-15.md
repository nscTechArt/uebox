# Python API 执行前检查设计（2026-10-15）

**状态**：设计稿，未实现。代码位置按 2026-10-15 的 `main` 核对。
**起因**：经验系统靠「失败 → 成功」一条条学「某类没有某成员」这类事实，每个工具 5 条上限，这些事实把做法经验挤掉了。本稿看能不能在执行前直接问引擎「这个名字有没有」，让这类事实根本不用学。

---

## 0. 结论先行

**不用存根文件。改成脚本发出去之前，先拿脚本原文到用户已经连着的编辑器里做一次只读检查：把脚本里 `unreal.Xxx`、`unreal.Xxx.yyy` 这类写死的名字逐个查一遍，查不到就拦一次，并给出编辑器里实际存在的相近名字。**

- 题目设想的是读 `Intermediate/PythonStub/unreal.py`。这个文件要用户打开开发者模式、重启编辑器才会生成，而且每次启动都会弹一个进度框。拿不到「用户无感」，原因见第 2 节。
- 存根也是从「当前编辑器里加载了哪些 Python 类型」导出来的。`ue_run_python_script` 只有连着编辑器才跑得了，所以检查的时候编辑器一定在，直接问它比读一份可能过期的导出文件更准。
- 拿最近 7 天的真实记录（895 段脚本）回放：91 次「没有这个属性 / 找不到这个属性」的报错里，**能在执行前拦下 44 次（48%）**。去掉 4 次 `NoneType`（那是值为空，不是 API 写错），是 44/87 = 51%。735 段成功脚本里有 8 段（1.1%）会被误拦，8 段全是回放时引擎版本不一致造成的（见 3.4），直接问用户的编辑器就不会出现。
- 和经验系统的分工：**「名字存不存在」交给这项检查，不再写成经验。** 经验只记它查不到的两类：一是变量上的成员，脚本里推不出变量是什么类型；二是做法，比如「AssetData 拿对象要用 get_asset」。5 条名额就留给这两类。

---

## 1. 打个比方

现在的经验系统像一个老员工的便利贴：写错一次 API，记一张「Character 没有 is_hidden」。贴多了工位放不下，有用的做法反而被挤掉。

这项检查像**发邮件前的拼写检查**。不用记谁上次拼错了什么，词典就在手边（用户开着的编辑器），发之前把每个词查一遍。拼写检查管「这个词存不存在」，便利贴只记词典里查不到的东西：哪个词在什么场合该用，这家公司的习惯是什么。

---

## 2. 存根文件：怎么生成、何时过期、能不能无感拿到

以下按 UE 5.5 的 `PythonScriptPlugin` 源码核对，并在本机实跑过。

### 2.1 怎么生成

| 途径 | 怎么触发 | 实测 / 源码事实 |
|---|---|---|
| 开发者模式 | 编辑器偏好或项目设置里打开 Python「Developer Mode」，并重启编辑器 | 只在编辑器里、而且不是 commandlet 时才生成（`PythonScriptPlugin.cpp` 的 `GenerateStubCode`）。启动后会延迟一帧生成，生成时弹出模态进度框「Generating unreal.py...」。之后每加载一个模块（`OnModulesChanged → RequestStubCodeGeneration`）都会重新生成一次。开发者模式还会把弃用警告打开（`EnableDeveloperWarnings`）。 |
| Commandlet | `UnrealEditor-Cmd.exe <工程> -run=PythonOnlineDocs -NoHTML` | 无界面也能生成。用空白工程在 UE 5.5 上实跑：**24–26 秒**，存根 **23.7 MB**，打开 6 个常用插件后是 **27.0 MB**。但它会往**引擎安装目录**的 `PythonScriptPlugin/SphinxDocs/` 写约 8000 个文件、23 MB，加了 `-NoHTML` 也照写。实测后这些文件已删掉。 |

两条途径都写到 `<工程>/Intermediate/PythonStub/unreal.py`。

### 2.2 何时过期

存根是**某一刻**编辑器里已加载类型的快照，下面几种情况都会让它和实际对不上：

- **引擎升级**：类和函数会增删、改名。回放里 5.5 和 5.7 有 3 个名字不同（3.4）。
- **插件开关**：存根只包含当时启用的插件。空白工程导出的存根没有 `MoviePipelineQueueSubsystem` 和 `GeometryScript_*`，拿它查就误报了 123 段成功脚本。打开 MovieRenderPipeline、PCG、GeometryScripting 后误报基本消失。
- **工程自己的 C++ 模块和蓝图类**：编译之后或加载之后才出现。
- **开发者模式关掉以后**：旧文件留在磁盘上，再也不更新。这是最危险的情况：文件在，但已经过期，单看文件分辨不出来。

### 2.3 能不能做到用户无感

**不能。** 逐条说：

1. **开发者模式**：盒子可以悄悄改 ini，但要等用户重启编辑器才生效。生效以后，每次启动都弹「Generating unreal.py…」，还会多出一批弃用警告，而这些都不是用户要的。用户是 UE 开发者，不是运维，不能让他们为盒子的内部检查去改编辑器设置，再去忍受副作用。
2. **Commandlet**：等于在用户工程上再起一个编辑器进程。C++ 工程要先有编好的编辑器二进制，大工程扫资产要几分钟、几个 GB 内存，还会和用户正开着的编辑器抢日志、ini 和 DDC。另外它会往引擎安装目录写文件，装在 Program Files 下的引擎会因为没有写权限而失败。重负载任务按规矩要低优先级、一次只跑一个，而这件事每次升级或开关插件都得重跑一遍。

**还有更直接的办法**：存根只是把 `dir(unreal)` 和各个类的 `__doc__` 写成文件。这些信息在用户开着的编辑器里现成就有，问一次只要几十毫秒。

---

## 3. 能静态查到什么程度（覆盖率估算）

### 3.1 样本

- `%APPDATA%/unreal-box/experience/.trail`，17 个会话，2026-10-08 ~ 10-14。原始账只保留 7 天，所以只有这么多。
- 引擎以 UE 5.7.4 为主，另有 1 个 5.0.3 会话。
- `ue_run_python_script` 共 895 次调用都带全文：成功 735 次，失败 160 次。
- 失败里属于「没有这个属性」的：`AttributeError: ... has no attribute` 72 次，`failed to find property` 19 次，**合计 91 次，占 Python 失败的 57%，占全部脚本的 10%**。

### 3.2 按「执行前能不能看出类型」分

| 报错形态 | 次数 | 脚本里通常怎么写 | 执行前能查吗 |
|---|---|---|---|
| `module 'unreal' has no attribute 'X'` | 17 | `unreal.X` | **能**，17/17 都是直接写出来的 |
| `type object 'C' has no attribute 'm'` | 22 | `unreal.C.m`，或 `MEL = unreal.C` 之后写 `MEL.m` | **能**，19 次直接写，3 次经过一次别名 |
| `'C' object has no attribute 'm'` | 29 | `v.m`，`v` 是变量 | 部分能：`v = unreal.get_editor_subsystem(unreal.C)`、`v = unreal.C(...)` 这几种写法能推出类型（5 次），其余来自循环、函数返回值、参数，推不出 |
| `failed to find property 'p' on 'C'` | 19 | `v.set_editor_property('p', …)` | 部分能：`v` 来自 `get_component_by_class(unreal.C)` 这类写法时能推出类型，大多推不出 |
| `'nonetype' object has no attribute` | 4 | 查找结果为空 | 不能，这不是 API 写错 |

### 3.3 原型回放结果

原型思路与第 4 节的设计相同：用 `ast` 解析脚本，跳过 `try/except` 里的引用、`hasattr/getattr` 检查过的名字、脚本自己往 `unreal` 上挂的名字（模型常写 `unreal._night_v2 = ...`）。名字表是 5.5 + 6 插件导出的存根，因为本机的 5.7 引擎所在的 I 盘没挂上。

| 检查范围 | 91 次里拦下 | 735 段成功脚本里误拦 |
|---|---|---|
| 只查直接写出的 `unreal.X` / `unreal.X.y` / 一次别名 | 38（42%） | 8（1.1%） |
| 再加上面那几种简单的类型推断 | **44（48%）** | 8（1.1%） |
| 同上，但 `try` 里的引用也拦 | 44 | 21（2.9%） |

被拦下的 44 次里，约 15 次是模型自己写的 `print(unreal.X.y.__doc__)`，在摸 API。剩下约 29 次是干活的脚本，其中有的跑到一半才报错，前面的改动已经落进关卡了；执行前拦下就不会留下这种半截状态。

**附带的相近名字基本都对得上正确答案**（摘录）：

- `EditorActorSubsystem.get_editor_world` → `get_world`
- `unreal.EDrawDebugTrace` → `DrawDebugTrace`，`unreal.ESplineCoordinateSpace` → `SplineCoordinateSpace`
- `unreal.EditorStaticMeshSubsystem` → `StaticMeshEditorSubsystem`
- `unreal.KismetProceduralMeshLibrary` → `ProceduralMeshLibrary`
- `MovieSceneSectionExtensions.get_channels` → `get_all_channels`
- `MaterialEditingLibrary.get_material_instance_texture_parameter_names` → `get_material_instance_texture_parameter_value`

### 3.4 误拦的 8 段

全是回放用的名字表（5.5）比实际运行的引擎（5.7）老：`SubobjectDataBlueprintFunctionLibrary.get_associated_object` 出现 6 段，`MovieSceneBindingExtensions.get_possessed_object` 和 `SceneComponent.get_component_transform` 各 1 段。直接问用户的编辑器，版本和插件天然一致，这 8 段不会被拦。

**真实环境里仍可能误拦的情况**：脚本自己先 `load_module`、`load_class`，加载完新类型再用。检查时类型还没加载，运行时已经有了。这种情况少，靠第 4.3 节「原样再发一次就放行」兜底。

### 3.5 查不到的那一半

剩下 43 次（不含 NoneType）几乎都是这样的：

```python
for a in unreal.EditorActorSubsystem().get_all_level_actors():
    a.get_actor_name()
```

要推出 `a` 的类型，需要知道函数的返回类型。就算推出来，也只是 `Array[Actor]`：成员在 `StaticMeshActor` 上有、在 `Actor` 上没有的，照样分不清，硬拦就会误拦。**这部分留给经验系统。**

---

## 4. 设计

### 4.1 流程

```
模型发 ue_run_python_script（带 script 全文）
  → beforeToolCall：熔断 → 【API 检查】 → 经验执行前提醒 → 审批
      API 检查：把脚本原文当作「数据」交给编辑器里一段固定的只读检查脚本
        - ast 解析，找出 unreal.X / unreal.X.y / 一次别名 / 简单推断出的变量成员 / get|set_editor_property('p')
        - 用真实 getattr / dir() / __doc__ 里的 Editor Properties 判断有没有
        - 没有 → 用 difflib 在 dir() 里找 3 个相近名字
      有不存在的名字 → 拦一次，告诉模型哪一行、哪个名字、相近的有哪些
      没有 / 编辑器没连 / 检查超时出错 → 放行
```

- **用户的代码一行都不执行。** 检查脚本只对原文做 `ast.parse`，原文作为 JSON 字符串传进去，和 `probe.ts` 的 `buildProbeScript` 一个做法。所以它可以排在审批前面，和现在的经验执行前提醒同一个位置（`createAgent.ts` 的 `beforeToolCall`）。
- **走现有的 `runEditorPython`**（`cmd.run_python` RPC），超时给短一点，比如 3 秒，超时就放行。`ExecPythonCommandEx` 会阻塞游戏线程，但 `ast` 解析加几百次 `getattr` 只要几十毫秒，和脚本本身的执行时间比可以忽略。上线前要在真机上量一次（见第 7 节）。
- **不受「技能学习」开关控制。** 它查的是引擎的客观事实，不是学来的东西。

### 4.2 交给模型的那段话

格式沿用 `formatPrecheck`：

```
[API check — not executed] These names do not exist in this editor (UE 5.7, this project's plugins):
- line 3 `unreal.EditorActorSubsystem.get_editor_world` — similar: get_world
- line 9 `unreal.EDrawDebugTrace` — similar: DrawDebugTrace
Fix it and send again. If you are sure it is fine here, send the exact same code again and it will run.
```

如果某个名字在经验库里正好有同一个 `symbol` 的经验（比如做法里写了「改用 UnrealEditorSubsystem」），就把那条 advice 接在这一行后面。存在与否由检查判断，经验只补充怎么改。

### 4.3 只拦一次

和 `precheck.ts` 同一套规矩：用 `codeDigest` 认出「原样又发了一次」，第二次直接放行。两种拦截**合成一条消息、共用一个摘要**：模型改一次、重发一次就够，不会先被 API 检查拦一次，改完再被经验拦一次。

被拦后原样重发而且跑成功了，说明检查错了（多半是 3.4 说的那种动态加载）。在原始账里记一笔 `apiCheckOverridden`，用来监控误拦率，不需要自动降级任何东西，因为结论来自引擎。

### 4.4 以后的优化（一期不做）

- **每个连接缓存「已确认存在」的名字。** 一个会话里，脚本反复用的就是那几十个 API。盒子先用正则扫一遍，所有引用都在缓存里就跳过这次 RPC。等一期量出真实耗时再决定做不做。
- **API 查询工具**：895 段脚本里有 202 段（23%）在 `dir()` 或 `__doc__` 里摸 API，是这项检查管不到的另一笔开销。常驻工具预算已满，只能放进按需子组。另起一稿讨论。

---

## 5. 和现有经验系统怎么分工

| 模块 | 现在管什么 | 加上 API 检查以后 |
|---|---|---|
| `precheck.ts`（执行前提醒） | 用已验证经验里的 `avoid` 写法正则扫脚本 | 拦截机制（摘要、拦一次、重发放行）不变，和 API 检查合成一条消息。脚本里直接写出的名字由 API 检查给出权威结论：API 检查说某个名字**存在**，就不再拿「这个名字不存在」的经验拦它，免得旧版本的经验在新引擎上误拦。 |
| `specificity.ts`（`symbolOf`、`errorProblem`） | 判断报错值不值得学，抽出 `类.成员` 钥匙 | `errorProblem` 加一种情况 `api-checkable`：报错是 module 或 type object 形态，或者失败脚本里能找到直接写出的 `unreal.<类>.<成员>`，就**不学**，因为下次执行前就能拦住。判断用失败脚本全文（原始账里有）做大小写不敏感的匹配，和本稿 3.2 的统计口径一样，不需要编辑器在线。`symbolOf` 的格式不变，API 检查的结果也用这个格式，好和经验对上号。 |
| `probe.ts`（整理员到引擎里验真） | 写经验前用 `dir()` 核实「类.成员」 | 和 API 检查共用同一段名字解析逻辑：大小写不敏感地在 `dir(unreal)` 里找类，再 `dir(类)`。它仍然负责验证变量成员类的经验。 |
| 经验库（每工具 5 条） | 混着装「名字存不存在」和「怎么做」 | 只装 API 检查查不到的：变量上的成员事实（`AssetData` 没有 `object_path`），以及做法。 |

**和隔壁会话的关系**：另一个会话正在把「API 事实」和「做法经验」分开管理。按本稿的结论，**API 事实里凡是直接写出来的名字，都不用存**；要存的只剩变量成员那一类。建议两边对齐 `api-checkable` 的判据，避免一个会话在拆分存储，另一个会话又判定这些事实根本不用存。

拿本机现有的 8 条 `ue_run_python_script` 经验对照：有 3 条在回放里会被 API 检查直接拦下，以后不用再存，分别是 `unreal.DependencyQuery`、`MaterialEditingLibrary.get_material_expressions`（脚本里经过一次别名）、`LevelEditorSubsystem.set_level_viewport_camera_info`（变量来自 `get_editor_subsystem`）。最后这条已经因为拦错被退役了。有 3 条仍然要靠经验：`AssetData.object_path`、`StaticMeshActor.get_actor_name`（两条都是循环变量上的成员），以及 `set_level_viewport_camera_info` 的参数名。`NoneType` 那条本来就不是 API 事实。`set_actor_hidden_in_editor` 那条的原始记录已经超过 7 天被清掉，判断不了。

---

## 6. 用户看到什么

**什么都看不到。** 不加设置，不加界面，不弹窗，不要求打开开发者模式。用户唯一能感觉到的是，模型「试一下、报错、再改」的来回少了，关卡里也少了跑到一半留下的半截改动。

名词表：用户需要认识的新名词，**0 个**。

增减计数：

| 项 | 前 | 后 |
|---|---|---|
| 用户可见的设置 / 界面 | 0 | 0 |
| 每段脚本额外的编辑器 RPC | 0 | 1（一期；缓存后大多可省掉） |
| 模型可能收到的「未执行」提示种类 | 1（经验） | 1（两种合成一条） |
| 经验库里「名字不存在」类条目 | 占 `ue_run_python_script` 5 个名额里的约一半 | 只剩变量成员类 |

---

## 7. 分期与验收

1. **一期：API 检查本身。** 包括只读检查脚本、`beforeToolCall` 接入、和经验执行前提醒合成一条消息。验收靠真人：用插件真机探针在 5.0 / 5.5 / 5.7 上各跑一遍本稿 3.3 摘录的那批错误写法，确认都被拦下，相近名字也对；再量 RPC 耗时。
2. **二期：整理员不再学 `api-checkable`。** 包括 `specificity.ts` 加判据、`precheck.ts` 以 API 检查的结论为准。和隔壁会话的拆分方案一起定。
3. **以后**：名字缓存；API 查询工具（另起一稿）。

---

## 8. 未决问题

- 3 秒超时是拍的。如果某些工程的 `ExecPythonCommandEx` 排队明显变慢，要不要改成「检查在后台跑、超时就放行」？
- UE 5.0 自带的 Python 是 3.9，`ast` 的行号字段可用，但检查脚本要避开 3.10 以后才有的语法。
- 用 `difflib` 找相近名字，类上有几千个成员（`Actor` 那种）时每次要几毫秒到几十毫秒，可以接受；如果量出来偏慢，改成先按前缀筛一遍。

---

## 9. 实现落点（预估）

- 新增 `src/main/agent-v3/core/pythonApiCheck.ts`：`buildApiCheckScript(script)`（Python 字符串）、`readApiCheck(output)`、`formatApiCheck(misses)`，以及跑检查的函数（复用 `runEditorPython` 和 `projectTargetContext` 的定位方式，参照 `probe.ts` 的 `createEditorProbe`）。
- `src/main/agent-v3/core/createAgent.ts` `beforeToolCall`：在 `experienceRuntime()?.before` 之前调用，两边的结果合成一条 `block`，用同一个 `codeDigest` 放行。
- `src/main/agent-v3/experience/precheck.ts` / `runtime.ts`：把 `blocked` 摘要表抽出来，和 API 检查共用；`findAvoided` 跳过 API 检查已确认存在的名字。
- `src/main/agent-v3/experience/specificity.ts`：`errorProblem` 加 `api-checkable`（二期）。
- `src/main/agent-v3/experience/probe.ts`：名字解析逻辑抽成和检查脚本共用的一小段 Python。

估算用的回放脚本不进仓库，方法见第 3.3 节，换一份新的原始账可以照着重算。
