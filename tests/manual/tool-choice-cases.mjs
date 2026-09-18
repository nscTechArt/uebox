/**
 * 工具选择 A/B 的用例集（v2，2026-09-11 重写）。
 *
 * 配套：`tool-choice-bench.mjs`（跑）、`tool-choice-cases.test.ts`（体检这份清单本身）、
 * `docs/工具渐进式披露设计.md` §5（为什么这么设计）。
 *
 * ## v1 为什么废掉
 *
 * v1 问的是「这道题最终有没有调到某个工具」，而台架把工具执行桩掉了。
 * 于是几乎每道题都卡在同一处：模型先做定位查询（`ue_content_search`、
 * `material_describe`），桩返回一句「本次不执行」，它拿不到资产路径和 node id，
 * **正确地拒绝往下编**，然后停下来问用户。两臂被同一堵墙挡住，配对差 -0.8pp。
 * 量到的是墙的高度，不是模型的选择。
 *
 * 三条佐证：业务调用里 65%(A)/74%(B) 是定位查询；A 臂 125 个样本只有 1 个用满
 * 调用预算（模型是自己停的，不是被截断）；一步能答的题两臂 3/3，要先查再动手的
 * 两臂 0/3。
 *
 * ## v2 改了三件事
 *
 * **一、题面自带事实。** 资产路径、Actor 名、参数名直接写在题里 ——
 * 那正是一次定位查询会返回的东西。模型没有理由先去查，第一手就能是领域动作。
 *
 * **二、只判第一手。** `accept` 是「第一个领域动作」的合法答案集合，
 * 台架记下那一手就收工（`haltOnFirstDomainCall`）。伸向哪个工具在模型拿到任何
 * 返回**之前**就决定了，所以桩返回什么它根本看不到 —— v1 那个洞从根上不存在了。
 *
 * 这也正是要验的那个假设的形状：厂商说的是「超过 30–50 个工具，**选择**准确率
 * 会掉」。选择就是第一手。第二步之后是执行和完成度，那归
 * `ue-task-eval-hard.mjs` 的真机用例，两边不混算。
 *
 * **三、`accept` 是集合，不是单个工具。** 同一道题常有几条都对的路
 * （读材质可以 `material_describe` 也可以 `material_get_graph`）。
 * v1 钉死一个工具，结果 `r-selection` 那条把模型判错了 —— 它按系统提示词
 * 用 `ue_get_actor` + `targets.selection`，那是产品明写的正确做法。
 *
 * **`accept` 必须包含这一路的「读」工具。** 系统提示词明令「用之前必须先查
 * node id 和 pin 名」，所以第一手是 `material_describe` / `blueprint_get_graph`
 * **是产品规定的正确行为**，判成错就是在惩罚照做的模型（2026-09-11 的冒烟里
 * 三条正例全被这么误判了）。
 *
 * 连带的后果要说清楚：第一手基本被「先读」占住之后，这份台架量到的其实是
 * **领域路由**——伸进了哪个抽屉，而不是抽屉里挑得准不准。组内选择要等
 * 第二手，那需要真数据，归真机评测。别拿这份数据说「组内选得准」。
 *
 * `accept` 要**小而明确**（不超过 5 个）：写成半个组就只测出了组级路由，
 * 测不到组内选择，而后者正是 155 个工具的病。
 *
 * ## 四类用例
 *
 * | 类别 | 声明 | 判据 |
 * |---|---|---|
 * | 正例 | `accept` + `group` | 第一个领域动作落在 `accept` 里 |
 * | 邻域混淆例 | 正例 + `nearbyGroups` | 同上；另外单独记「取错了组」 |
 * | 跨组例 | 正例 + `crossGroups` | 同上；另外记 B 臂是不是一次把两组都取了 |
 * | 纯常驻例 | `residentOnly: true` | 同上；B 臂调了任何 finder 都是白花一步 |
 *
 * ## `say` 绝不能抄 finder 描述里的词
 *
 * finder 的一句话摘要就摆在模型的上下文里（`<deferred_tool_groups>`）。
 * 逐字用那些词等于把答案先给 B 臂看一遍，而 A 臂拿不到这份便宜。
 * 由 `tool-choice-cases.test.ts` 的显式名单守着。
 */

/**
 * 「不算数也不收工」的工具。
 *
 * 开工前问一句「现在开的是哪个工程」「这个资产在不在」是任何一路活都会做的
 * 第一步。把它判成答案不对（那不是这道题的领域动作），拿它收工也不对
 * （模型还没伸手呢）。所以它既不进 `accept`，也不触发收工。
 *
 * 名单**由评测这边给**，随请求发给调试端点 —— 它是评测口径，不属于产品。
 */
export const NEUTRAL_TOOLS = Object.freeze([
  'ue_get_project_info',
  'ue_get_selection',
  'ue_get_config',
  'ue_content_search',
  'ue_content_describe',
  'ue_get_current_level',
  'ue_get_levels',
  'ue_session_health',
  'search_assets',
  'library_overview',
  'list_local_dir',
  'read_local_file',
  'find_local_files',
  'grep_local_files',
  'load_skill',
  'read_skill_resource'
])

const D = { nearbyGroups: [], residentOnly: false }

export const CASES = Object.freeze([
  // ── blueprint ──────────────────────────────────────────────────────────
  {
    ...D,
    tag: 'bp-door',
    say: '/Game/BP/BP_Door 这个蓝图，我要让玩家走近了它自己开、走远了关上。它身上已经有一个叫 Trigger 的 BoxComponent 了，直接把逻辑接进 EventGraph。',
    accept: [
      'blueprint_get_graph',
      'blueprint_describe',
      'blueprint_apply_graph',
      'blueprint_component_event'
    ],
    group: 'blueprint',
    scope: ['ue.blueprint'],
    nearbyGroups: ['level']
  },
  {
    ...D,
    tag: 'bp-health',
    say: '给 /Game/BP/BP_Hero 加一个血量，float，初始 100，要能在场景里每个实例单独调。',
    accept: ['blueprint_add_variable', 'blueprint_describe'],
    group: 'blueprint',
    scope: ['ue.blueprint']
  },
  {
    ...D,
    tag: 'bp-compile',
    say: '我刚手动改了好几个蓝图，帮我把工程里的蓝图全过一遍看有没有报错的。',
    accept: ['blueprint_compile_all'],
    group: 'blueprint',
    scope: ['ue.blueprint'],
    nearbyGroups: ['engineops']
  },
  {
    ...D,
    tag: 'bp-parent',
    say: '/Game/BP/BP_Enemy 现在是从 Actor 继承的，改成从 Character 继承。',
    accept: ['blueprint_set_parent_class', 'blueprint_describe'],
    group: 'blueprint',
    scope: ['ue.blueprint']
  },
  {
    ...D,
    tag: 'bp-read',
    say: '/Game/BP/BP_Door 的 EventGraph 里现在都接了些什么？我想先看看再动。',
    accept: ['blueprint_get_graph', 'blueprint_describe'],
    group: 'blueprint',
    scope: ['ue.blueprint']
  },

  // ── material ───────────────────────────────────────────────────────────
  {
    ...D,
    tag: 'mat-red',
    say: '在 /Game/Test 底下建一个叫 M_EvalRed 的东西，能刷在墙上、看起来是红的。',
    accept: ['material_create'],
    group: 'material',
    scope: ['ue.material']
  },
  {
    ...D,
    tag: 'mat-rough',
    say: '/Game/Art/M_Wall 太亮了跟塑料一样，把粗糙度调到 0.8。它上面有个叫 Roughness 的标量参数。',
    accept: [
      'material_get_graph',
      'material_describe',
      'material_set_param',
      'material_set_node_value'
    ],
    group: 'material',
    scope: ['ue.material'],
    nearbyGroups: ['engineops']
  },
  {
    ...D,
    tag: 'mat-instance',
    say: '/Game/Art/M_Rock 我想要五个颜色不一样的版本，但别复制五份母材质各改各的。',
    accept: ['material_create_instance', 'material_describe'],
    group: 'material',
    scope: ['ue.material']
  },
  {
    ...D,
    tag: 'mat-apply',
    say: '把 /Game/Art/M_Rock 挂到场景里那个叫 SM_Cliff_01 的物体上。',
    accept: ['material_apply', 'material_describe'],
    group: 'material',
    scope: ['ue.material', 'ue.actor']
  },
  {
    ...D,
    tag: 'mat-read',
    say: '/Game/Art/M_Wall 里面到底连了些什么节点？先给我看一眼。',
    accept: ['material_get_graph', 'material_describe'],
    group: 'material',
    scope: ['ue.material']
  },

  // ── pcg ────────────────────────────────────────────────────────────────
  {
    ...D,
    tag: 'pcg-trees',
    say: '/Game/Maps/Forest 这张图里的山坡我想让它长满树，一棵棵手摆要摆到明年，来个能一次铺开的做法。',
    accept: ['pcg_create_graph', 'pcg_spawn_volume', 'pcg_status', 'pcg_scene_report'],
    group: 'pcg',
    scope: ['ue.pcg'],
    nearbyGroups: ['level']
  },
  {
    ...D,
    tag: 'pcg-run',
    // 路径里不带 PCG 三个字母：那三个字母同时出现在 finder 摘要和工具名里，
    // 等于把「该找哪个抽屉」直接写进题面。要考的正是「自动摆石头的图」
    // 到底属于哪一路
    say: '/Game/Maps/Forest_Rocks 那张自动摆石头的图我改完了，让它重新算一遍，场景里现在看不到东西。',
    accept: ['pcg_execute', 'pcg_get_graph', 'pcg_status', 'pcg_scene_report'],
    group: 'pcg',
    scope: ['ue.pcg']
  },
  {
    ...D,
    tag: 'pcg-nodes',
    say: '/Game/Maps/Forest_Rocks 那张自动摆石头的图里，我要加一个按坡度筛选的节点，先看看有哪些节点可以用。',
    accept: ['pcg_list_node_types', 'pcg_get_graph', 'pcg_describe_node'],
    group: 'pcg',
    scope: ['ue.pcg'],
    nearbyGroups: ['blueprint']
  },

  // ── widget ─────────────────────────────────────────────────────────────
  {
    ...D,
    tag: 'ui-hud',
    say: '在 /Game/UI 底下做一个叫 WBP_HUD 的界面，左上角显示血条。',
    accept: ['widget_create'],
    group: 'widget',
    scope: ['ue.widget'],
    nearbyGroups: ['blueprint']
  },
  {
    ...D,
    tag: 'ui-button',
    say: '/Game/UI/WBP_Menu 里再加一个按钮，摆在那个 QuitButton 下面。',
    accept: ['widget_add_child', 'widget_get_hierarchy'],
    group: 'widget',
    scope: ['ue.widget']
  },
  {
    ...D,
    tag: 'ui-look',
    say: '/Game/UI/WBP_Menu 现在长什么样，给我看一眼。',
    accept: ['widget_preview', 'widget_get_hierarchy'],
    group: 'widget',
    scope: ['ue.widget', 'ue.editor']
  },
  {
    ...D,
    tag: 'ui-slot',
    say: '/Game/UI/WBP_Menu 里那个 StartButton 位置不对，往下挪 40 像素。',
    accept: ['widget_set_slot', 'widget_get_hierarchy'],
    group: 'widget',
    scope: ['ue.widget']
  },

  // ── sequencer ──────────────────────────────────────────────────────────
  {
    ...D,
    tag: 'seq-shot',
    say: '/Game/Cine/LS_Intro 这条时间轴里现在都有什么轨？我要做个片头。',
    accept: ['sequence_describe'],
    group: 'sequencer',
    scope: ['ue.sequencer']
  },
  {
    ...D,
    tag: 'seq-cut',
    say: '/Game/Cine/LS_Intro 里三个机位之间的切换是怎么排的？',
    accept: ['sequence_camera_cuts', 'sequence_describe'],
    group: 'sequencer',
    scope: ['ue.sequencer']
  },
  {
    ...D,
    tag: 'seq-push',
    say: '/Game/Cine/LS_Intro 里那个 CineCameraActor_0，让它在 0 到 3 秒之间从远处推到近处。',
    accept: ['sequence_camera_keys'],
    group: 'sequencer',
    scope: ['ue.sequencer']
  },
  {
    ...D,
    tag: 'mesh-info',
    say: '/Game/Props/SM_Chair 有多少个面？UV 通道有几套？',
    accept: ['mesh_describe'],
    group: 'sequencer',
    scope: ['ue.mesh'],
    nearbyGroups: ['content']
  },

  // ── content ────────────────────────────────────────────────────────────
  {
    ...D,
    tag: 'ct-import',
    say: 'H:/UnrealAgent/unreal-box-core/.test/bench-fixture/downloads/rocks 里有一堆 fbx，弄进工程的 /Game/Art/Rocks 底下。',
    accept: ['ue_content_import'],
    group: 'content',
    scope: ['ue.content'],
    nearbyGroups: ['assetlib']
  },
  {
    ...D,
    tag: 'ct-naming',
    say: '/Game 底下的资产命名乱七八糟，帮我看看有多少不合规矩的。',
    accept: ['ue_content_naming_audit'],
    group: 'content',
    scope: ['ue.content'],
    nearbyGroups: ['assetlib']
  },
  {
    ...D,
    tag: 'ct-deps',
    say: '/Game/Art/M_Master 要是删了，会有多少东西跟着坏掉？',
    accept: ['ue_content_dependencies'],
    group: 'content',
    scope: ['ue.content']
  },
  {
    ...D,
    tag: 'ct-move',
    say: '把 /Game/Temp 底下那些贴图全挪到 /Game/Art/Textures 去，引用别断了。',
    accept: ['ue_content_move', 'ue_content_dependencies'],
    group: 'content',
    scope: ['ue.content'],
    nearbyGroups: ['assetlib']
  },
  {
    ...D,
    tag: 'ct-size',
    say: '/Game/Art/SM_Statue 连着它引用的东西一共占多大？',
    accept: ['ue_asset_size_map'],
    group: 'content',
    scope: ['ue.content'],
    nearbyGroups: ['engineops']
  },

  // ── assetlib ───────────────────────────────────────────────────────────
  {
    ...D,
    tag: 'al-tag',
    say: '我素材库里那把叫 Chair_Nordic 的椅子，给它标上「北欧」和「木头」，以后好找。',
    accept: ['annotate_asset', 'list_tags'],
    group: 'assetlib',
    scope: ['asset'],
    nearbyGroups: ['content']
  },
  {
    ...D,
    tag: 'al-folder',
    say: '在我的素材库里建一个叫「废弃工厂」的分类。',
    accept: ['create_folders'],
    group: 'assetlib',
    scope: ['asset'],
    nearbyGroups: ['content']
  },
  {
    ...D,
    tag: 'al-restore',
    say: '我昨天在素材库里删错东西了，能找回来吗？',
    accept: ['restore_assets'],
    group: 'assetlib',
    scope: ['asset']
  },
  {
    ...D,
    tag: 'al-merge',
    say: '我素材库里「树」「树木」「Tree」是三个标签，其实是一回事，合成一个。',
    accept: ['delete_tags', 'manage_tags', 'list_tags'],
    group: 'assetlib',
    scope: ['asset']
  },

  // ── aigc ───────────────────────────────────────────────────────────────
  {
    ...D,
    tag: 'ai-image',
    say: '我需要一张赛博朋克风格的街道概念图当参考，手上什么都没有。',
    accept: ['generate_image'],
    group: 'aigc',
    scope: ['aigc']
  },
  {
    ...D,
    tag: 'ai-3d',
    say: 'H:/UnrealAgent/unreal-box-core/.test/bench-fixture/ref/chair.png 这张椅子照片，能不能直接变成一个能放进场景的模型？',
    accept: ['generate_3d_model'],
    group: 'aigc',
    scope: ['aigc'],
    nearbyGroups: ['content']
  },

  // ── engineops ──────────────────────────────────────────────────────────
  {
    ...D,
    tag: 'eo-fps',
    say: '这个场景跑起来很卡，帮我看看卡在哪。',
    accept: ['ue_get_performance_stats', 'ue_capture_perf_trace'],
    group: 'engineops',
    scope: ['ue.system'],
    nearbyGroups: ['content']
  },
  {
    ...D,
    tag: 'eo-crash',
    say: '编辑器刚才自己关了，能查到是什么原因吗？',
    accept: ['ue_get_crash_logs'],
    group: 'engineops',
    scope: ['ue.system']
  },
  {
    ...D,
    tag: 'eo-plugin',
    say: '我这工程里 Niagara 是开着的吗？没开的话打开。',
    accept: ['ue_manage_plugin'],
    group: 'engineops',
    scope: ['ue.system']
  },
  /*
   * Insights 两合一（2026-09-11）的验收用例。accept 同时收旧名和新名：
   * 合并前只有旧工具存在，合并后只有新工具存在，同一份用例两边都能跑。
   * 对象写法连 action 和关键参数一起判 —— 合并后「把 capture 错选成 analyze」
   * 或者把 15 秒丢掉，都不算命中。
   */
  {
    ...D,
    tag: 'eo-insights-rec',
    say: '帮我录一段 Unreal Insights 的 trace，我要看具体是哪个函数在吃 CPU，录 15 秒就行。',
    accept: [
      { tool: 'ue_capture_insights_trace', params: { duration_seconds: 15 } },
      { tool: 'ue_insights_trace', action: 'capture', params: { duration_seconds: 15 } }
    ],
    group: 'engineops',
    scope: ['ue.system'],
    nearbyGroups: []
  },
  {
    ...D,
    tag: 'eo-insights-read',
    say: 'H:/UnrealAgent/unreal-box-core/.test/bench-fixture/Saved/Profiling/Capture_20260911.utrace 这个 trace 我已经录好了，帮我看看里面哪个计时器最费时间。',
    accept: [
      {
        tool: 'ue_analyze_insights_trace',
        params: {
          utrace_path:
            'H:/UnrealAgent/unreal-box-core/.test/bench-fixture/Saved/Profiling/Capture_20260911.utrace'
        }
      },
      {
        tool: 'ue_insights_trace',
        action: 'analyze',
        params: {
          utrace_path:
            'H:/UnrealAgent/unreal-box-core/.test/bench-fixture/Saved/Profiling/Capture_20260911.utrace'
        }
      }
    ],
    group: 'engineops',
    scope: ['ue.system'],
    nearbyGroups: []
  },
  {
    ...D,
    tag: 'eo-cpp',
    say: '我改了 C++ 代码，现在能不能编一下？',
    accept: ['cpp_probe', 'cpp_compile', 'cpp_list_modules'],
    group: 'engineops',
    scope: ['ue.cpp']
  },

  // ── level ──────────────────────────────────────────────────────────────
  {
    ...D,
    tag: 'lv-open',
    say: '把 /Game/Maps/Forest 那张图打开。',
    accept: ['ue_open_level'],
    group: 'level',
    scope: ['ue.level']
  },
  {
    ...D,
    tag: 'lv-outliner',
    say: '大纲里几百个 Actor 平铺着找不到东西，按类型归归类。',
    accept: ['level_organize_actors'],
    group: 'level',
    scope: ['ue.level'],
    nearbyGroups: ['assetlib']
  },
  {
    ...D,
    tag: 'lv-play',
    say: '现在跑一下游戏，看看会不会报错。',
    accept: ['ue_playtest'],
    group: 'level',
    scope: ['ue.editor', 'ue.level'],
    nearbyGroups: ['engineops']
  },
  {
    ...D,
    tag: 'lv-input',
    say: '游戏里按 W 是往前走吗？我想确认一下现在的键位。',
    accept: ['ue_input_map'],
    group: 'level',
    scope: ['ue.input'],
    nearbyGroups: ['blueprint']
  },
  {
    ...D,
    tag: 'lv-heavy',
    say: '/Game/Maps/Forest 这张图里哪些资产最重？',
    accept: ['ue_find_heavy_assets'],
    group: 'level',
    scope: ['ue.level'],
    nearbyGroups: ['content']
  },

  // ── 跨组例：一句话要两组。B 臂该在同一条回复里把两个 finder 一起发出来 ──
  {
    ...D,
    tag: 'x-mat-actor',
    say: '在 /Game/Test 建一个会一闪一闪发光的材质叫 M_Glow，再让场景里那个 SM_Sign_01 用上它。',
    accept: ['material_create'],
    group: 'material',
    crossGroups: ['material'],
    scope: ['ue.material', 'ue.actor']
  },
  {
    ...D,
    tag: 'x-import-tag',
    say: 'H:/UnrealAgent/unreal-box-core/.test/bench-fixture/downloads/props 里那批模型导进 /Game/Art/Props，顺手在我素材库里也给它们标上「道具」。',
    accept: ['ue_content_import'],
    group: 'content',
    crossGroups: ['content', 'assetlib'],
    scope: ['ue.content', 'asset']
  },
  {
    ...D,
    tag: 'x-ui-logic',
    say: '在 /Game/UI 做个叫 WBP_Pause 的暂停菜单，按 Esc 弹出来，再按一次收回去。',
    accept: ['widget_create'],
    group: 'widget',
    crossGroups: ['widget', 'blueprint'],
    scope: ['ue.widget', 'ue.blueprint']
  },
  {
    ...D,
    tag: 'x-perf-content',
    say: '打包出来太大了，帮我找出工程里最占地方的那些资产。',
    accept: ['ue_project_asset_ranking'],
    group: 'content',
    crossGroups: ['content', 'engineops'],
    scope: ['ue.content', 'ue.system']
  },

  // ── 纯常驻例：B 臂调任何 finder 都是白花一步 ──────────────────────────
  {
    ...D,
    tag: 'r-project',
    say: '我现在开的是哪个工程？用的哪个引擎版本？',
    accept: ['ue_get_project_info'],
    group: null,
    residentOnly: true,
    scope: ['ue.editor']
  },
  {
    ...D,
    // v1 这条把模型判错了：它按系统提示词用 `ue_get_actor` + `targets.selection`，
    // 那正是产品明写的正确做法，而 v1 只认 `ue_get_selection`
    tag: 'r-selection',
    say: '我在场景里选中的这个是什么东西？',
    accept: ['ue_get_selection', 'ue_get_actor'],
    group: null,
    residentOnly: true,
    scope: ['ue.editor', 'ue.actor']
  },
  {
    ...D,
    tag: 'r-search',
    say: '工程里有没有叫 SM_Chair 的东西？',
    accept: ['ue_content_search'],
    group: null,
    residentOnly: true,
    scope: ['ue.content']
  },
  {
    ...D,
    tag: 'r-spawn',
    say: '在原点放一个立方体。',
    accept: ['ue_spawn_actor'],
    group: null,
    residentOnly: true,
    scope: ['ue.actor']
  },
  {
    ...D,
    tag: 'r-screenshot',
    say: '给我拍一张现在视口里的画面。',
    accept: ['ue_screenshot'],
    group: null,
    residentOnly: true,
    scope: ['ue.editor']
  },
  {
    ...D,
    tag: 'r-save',
    say: '刚才那些改动存一下盘。',
    accept: ['ue_save'],
    group: null,
    residentOnly: true,
    scope: ['ue.editor']
  },
  {
    ...D,
    tag: 'r-undo',
    say: '你刚才做的那步撤了吧，我不要了。',
    accept: ['ue_undo', 'ue_undo_history'],
    group: null,
    residentOnly: true,
    scope: ['ue.editor']
  },
  {
    ...D,
    tag: 'r-move',
    say: '把场景里那个 SM_Cliff_01 往上抬 200。',
    accept: ['ue_set_transform'],
    group: null,
    residentOnly: true,
    scope: ['ue.actor']
  }
])

/**
 * 配对随机化的先后表。
 *
 * 固定交替（A 永远先跑）时，任何单调漂移 —— 服务端更新、时段负载 —— 都会被
 * 系统性地算成 B 的改善。种子固定，跑完不许重排；换种子等于换实验。
 *
 * 判据和这份表的作用见 `docs/review/技能路由A-B预登记-2026-09-08.md` §4，
 * 那份文档里的论证一字不改地适用于这里。
 */
export const PAIRED_SEED = 20260911

/** 线性同余，够用且可复现 —— 不引入依赖 */
export function pairedSchedule(caseCount, repeats, seed = PAIRED_SEED) {
  let state = seed >>> 0
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
  const plan = []
  for (let i = 0; i < caseCount; i++) {
    for (let r = 0; r < repeats; r++) {
      // 平衡先后：偶数次重复强制各一半，奇数那次才掷骰子
      const forced = r < Math.floor(repeats / 2) ? 'AB' : r < repeats - (repeats % 2) ? 'BA' : null
      plan.push({ caseIndex: i, repeat: r, order: forced ?? (next() < 0.5 ? 'AB' : 'BA') })
    }
  }
  return plan
}
