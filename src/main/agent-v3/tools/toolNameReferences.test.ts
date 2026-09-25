/** @vitest-environment node */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { electronMock, servicesMock, targetContextMock } from '../testSupport/toolMocks'

// 工厂要包一层箭头函数：`vi.mock` 提升到 import 之前，直接传引用会在初始化前访问它
vi.mock('electron', () => electronMock())
vi.mock('../../services', () => servicesMock())
vi.mock('../core/projectTargetContext', async (importOriginal) => targetContextMock(importOriginal))

import { lintSkillFile } from '../capabilities/skillLint'
import { allToolNames, buildAllTools } from './registry'

/**
 * 工具名不许指向不存在的工具 —— 常驻上下文的那两处都查：**工具自己的描述**，
 * 和**仓库自带的 skill**。
 *
 * ## 为什么补这道
 *
 * `material_add_node` / `material_connect_pins` 早就下线了
 * （registry.test.ts 里有断言守着它们不许出现），可 `ue-material` 的工具描述和
 * 参数说明里还有 **12 处**在教模型「创建后用 material_add_node 添加节点」，
 * 其中几处还写在 `toOutcome` 里 —— 也就是调用成功之后**当场**递给模型一句
 * 「下一步调这个不存在的工具」。`blueprint_search_nodes` 同样指着
 * `blueprint_add_node`。
 *
 * 这类错不会报错：模型照着调，拿一句「工具不存在」，然后换个名字反复试。
 * 而工具描述是**每一轮都在上下文里**的，代价按会话数计。
 *
 * `skillLint` 已经会查这件事，但它只挂在写入工具的返回值上
 * （registry.ts 的 `lintWrittenSkill`），只体检**模型现写的**那一份；
 * 仓库自带的 skill 和工具描述本身从来没走过那条路。
 *
 * `scripts/check-skills.mjs` 也接不了：它是纯 node 脚本，拿不到注册表
 * （注册表要 import electron 和 services）。所以这道只能是测试。
 *
 * ## 为什么不扫 packages/cli/skills
 *
 * 那批随 uebox CLI 发给**外部** agent，教的是命令行子命令，不是这份注册表里的
 * 工具名。拿这里的清单去判它，判出来全是误报。
 */

const known = allToolNames()

/** 真工具名的首段，用来判「这个 token 长得像不像我们的工具名」 */
const PREFIXES = new Set([...known].map((n) => n.split('_')[0]!))

/**
 * 人工过目确认**不是**工具名的 token。
 *
 * 每条都写清它到底是什么 —— 空写一个名字进来，下一个人无从判断该不该删。
 * 加新条目之前先确认它真的不是工具名；这张表变长本身就是个信号。
 */
const NOT_TOOL_NAMES: Record<string, string> = {
  // —— 工具返回体里的字段 ——
  render_thread_ms:
    'ue_get_performance_stats 的渲染线程耗时字段；render_task_video 新增 render 前缀后会被扫描到',
  blueprint_path: 'ue_get_actor / blueprint_search_nodes 返回的字段',
  blueprint_name: 'blueprint_add_component 的参数',
  material_slots: 'ue_content_describe 的 details 字段',
  library_sample: 'search_assets 零命中回退时返回的字段',
  cpp_name: 'blueprint_search_nodes 返回的字段（C++ 里的函数名）',
  write_as: 'blueprint_get_graph / blueprint_library_save 的参数',
  delete_broken: 'ue_fixup_redirectors / ue_content_rollback 的参数',
  move_input_ignored: 'ue_inject_input 返回的字段',
  rename_asset: 'ue_run_python_script 描述里举例的 unreal Python API',
  // `rename_folder` 让 `rename` 成了已知前缀，于是这个响应字段被当成工具名
  rename_failed: 'ue_content_import 的响应字段（asset_names 里没改成的那些）',
  /*
   * 这两个是 `IKRetargeterController` 的 Python 方法名，写在
   * `ue-animation-retargeting` 的 API 速查表里。
   *
   * 它们以前压根不会被查：`PREFIXES` 是从真工具名的首段算出来的，而在
   * `set_session_project` 进 `allToolNames()` 之前，没有任何工具以 `set` 开头。
   * 补上那个名字之后 `set` 成了已知前缀，这一整类 UE API 名字才跟着被扫进来。
   * 误报，不是新问题。
   */
  set_retarget_root: 'IKRetargeterController 的 unreal Python 方法',
  set_rotation_offset_for_retarget_pose_bone: 'IKRetargeterController 的 unreal Python 方法',
  // 2026-09-22 反馈后写进 SKILL.md 的两个常见报错点：枚举参数传成字符串、op 下标传成名字
  set_ik_rig: 'IKRetargeterController 的 unreal Python 方法',
  get_retarget_op_enabled: 'IKRetargeterController 的 unreal Python 方法（5.6+ op 栈）',
  blueprint_read_only: 'blueprint_library_apply 的参数',
  // `project_` 是真前缀（project_list / project_manage），所以响应字段被当成了工具名
  project_rule_renames: 'project_rules 的响应字段',
  project_path: 'project_package 的参数（工程目录）',
  material_name: 'material_create 的参数',
  widget_name: 'widget_* 那组工具的参数',
  sequence_path: 'sequence_* 那组工具的参数',
  sequence_paths: 'sequence_audit 的参数（可以一次查多条）',

  // —— project_list / project_manage / project_organize 的 action 取值 ——
  list_templates: 'project_list 的 action 取值',
  list_projects: 'project_list 的 action 取值',
  create_project: 'project_manage 的 action 取值',
  open_project: 'project_manage 的 action 取值',
  import_assets: 'project_manage 的 action 取值',
  setup_level_sequence: 'project_manage 的 action 取值',
  // 这两个撞上 update_* / delete_* 两个真前缀，另外三个动作（group_projects 等）
  // 首段不是任何工具的前缀，压根不会被扫到
  update_collection: 'project_organize 的 action 取值',
  delete_collection: 'project_organize 的 action 取值',

  // —— 引擎侧 Python API，不是我们的工具 ——
  load_asset: 'unreal.load_asset，Python API',
  // ue_content_delete / ue_run_python_script 的描述点名警告「别在 Python 里循环它」，
  // 和真工具 delete_assets 只差一个 s，但它就是 unreal.EditorAssetLibrary 的方法名
  delete_asset: 'unreal.EditorAssetLibrary.delete_asset，Python API',
  create_asset: 'unreal.AssetToolsHelpers 的 Python API',
  add_retarget_chain: 'IKRigController 的 Python 方法',
  run_batch_retarget: 'IKRetargetBatchOperation 的 Python 方法',
  create_new_static_mesh_asset_from_mesh: 'GeometryScript_NewAssetUtils 的 Python 方法',
  // 注册 get_note 之后 `get` 才成为工具名前缀，这个 token 才被扫出来 ——
  // 它一直是 unreal.GeometryScript_MeshQueries 的方法，不是工具
  get_is_closed_mesh: 'GeometryScript_MeshQueries 的 Python 方法',
  get_mesh_info_string: 'GeometryScript_MeshQueries 的 Python 方法',
  // ue-sequencer 的 SKILL.md 点名警告它的返回值：对不存在的名字回一个
  // bool() 为真、is_valid=False 的代理，拿它当存在性判据会让整批写入被静默跳过
  find_binding_by_name: 'MovieSceneSequenceExtensions 的 Python 方法',

  // —— 描述里的口语简写，不是完整工具名 ——
  add_param: '口语简写，指 blueprint_function_signature 的加参数动作',
  create_function: '口语简写，指 blueprint_create_function'
}

/**
 * 已下线的逐节点写图工具，**裸名**。
 *
 * 这一组单列，不走下面 `PREFIXES` 那条路，因为那条路两头都漏：
 *
 *   - `add_node` 曾经躺在 `NOT_TOOL_NAMES` 里，注明「口语简写」—— 于是
 *     `blueprint_create_function` 的描述写着「再在 graph_name 下 add_node/connect_pins
 *     编写逻辑」，门禁一声不吭。2026-09-12 由盒子自己的 agent 报出来
 *     ：它照着这句话找不到工具。
 *   - `connect_pins` 连嫌疑都算不上：`PREFIXES` 是从真工具名的首段算的，
 *     而没有任何工具以 `connect_` 开头。
 *
 * 带前缀的旧名（`blueprint.add_node`）不在这里 —— 那些由
 * `rewriteCrossReferences` 在装配时改掉，扫到的已经是改完的文字。
 * 漏网的恰恰是**不带前缀**的那种，映射表按点号匹配，碰不到它们。
 *
 * 这不是「口语」问题。描述里出现 `add_node` 只有两种可能：要么在教模型调一个
 * 不存在的工具，要么在指一个节点而没说清 —— 两种都该改成 blueprint_apply_graph
 * 或者干脆写「节点」。
 */
const RETIRED_BARE_NAMES = [
  'add_node',
  'connect_pins',
  'set_pin_value',
  'delete_node',
  'add_timeline',
  'build_logic'
] as const

/** 从一段文字里挑出「长得像我们的工具名、但注册表里没有」的 token */
function suspects(text: string, wrap: 'backtick' | 'bare'): string[] {
  const pattern =
    wrap === 'backtick'
      ? /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g
      : /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g
  const found = new Set<string>()
  for (const m of text.matchAll(pattern)) {
    const token = m[1]!
    // 已下线的裸名先判：它们既不在注册表里，也不该被 NOT_TOOL_NAMES 豁免掉
    if ((RETIRED_BARE_NAMES as readonly string[]).includes(token)) {
      found.add(token)
      continue
    }
    if (known.has(token) || NOT_TOOL_NAMES[token]) continue
    if (!PREFIXES.has(token.split('_')[0]!)) continue
    found.add(token)
  }
  return [...found]
}

describe('工具描述里不许出现不存在的工具名', () => {
  const tools = buildAllTools()

  it('扫得到工具（扫不到说明这道检查是空的）', () => {
    expect(tools.length).toBeGreaterThan(50)
  })

  it('这道检查真的会咬人 —— 拿当初漏掉的那句原文试一次', () => {
    expect(
      suspects('创建后用 material_add_node 添加节点、material_connect_pins 连线', 'bare')
    ).toEqual(['material_add_node', 'material_connect_pins'])
  })

  /**
   * 裸名那一路单独试一次。用的是 2026-09-12 真的漏出去的那句原文 ——
   * 带前缀的版本一直被咬，不带前缀的躺了不知道多久。
   */
  it('不带前缀的已下线名字同样会被咬', () => {
    expect(
      suspects('先 create_function，再在 graph_name 下 add_node/connect_pins 编写逻辑', 'bare')
    ).toEqual(['add_node', 'connect_pins'])
  })

  it('六个已下线的裸名一个都不许漏', () => {
    for (const name of RETIRED_BARE_NAMES) {
      expect(suspects(`照着 ${name} 写一段逻辑`, 'bare')).toContain(name)
    }
  })

  it.each(tools.map((t) => [t.name, t] as const))('%s', (_name, tool) => {
    // 描述 + 参数说明一起查：`.describe()` 的文字也是模型看得到的，
    // 那次 material_add_node 有 4 处正是写在参数说明里
    const text = `${tool.description ?? ''}\n${JSON.stringify(tool.parameters ?? {})}`
    expect(suspects(text, 'bare')).toEqual([])
  })
})

describe('自带 skill 的机器体检', () => {
  const SKILLS_DIR = join(process.cwd(), 'resources', 'skills')
  const skillNames = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

  it('扫得到 skill（扫不到说明这道检查是空的）', () => {
    expect(skillNames.length).toBeGreaterThan(10)
  })

  it.each(skillNames)('%s 结构完好、没有不存在的工具名', async (name) => {
    const problems = await lintSkillFile(join(SKILLS_DIR, name, 'SKILL.md'), known)

    // blocking = 这个 skill 根本加载不进来。文件躺在盘上、清单里没有，
    // 开发机上完全看不出来，用户那边表现为「这功能时灵时不灵」
    expect(problems.filter((p) => p.severity === 'blocking').map((p) => p.message)).toEqual([])

    // warn 里混着字段名和 Python API，靠上面那张表认领；剩下的必须是真问题
    const body = problems.map((p) => p.message).join('\n')
    expect(suspects(body, 'backtick')).toEqual([])
  })
})
