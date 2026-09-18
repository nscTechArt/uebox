import { describe, expect, it } from 'vitest'
import { changeLabelKey, isLocalFileChange, isMcpChange } from './changeSummary'

describe('isLocalFileChange', () => {
  it('盘符路径与 UNC 路径算本地文件', () => {
    expect(isLocalFileChange({ target: 'I:/UE Project/a/说明.html' })).toBe(true)
    expect(isLocalFileChange({ target: 'C:\\Users\\me\\a.cpp' })).toBe(true)
    expect(isLocalFileChange({ target: '\\\\nas\\share\\a.txt' })).toBe(true)
  })

  it('引擎内路径与空目标不算', () => {
    expect(isLocalFileChange({ target: '/Game/Blueprints/BP_Door' })).toBe(false)
    expect(isLocalFileChange({ target: 'BP_Door' })).toBe(false)
    expect(isLocalFileChange({ target: '' })).toBe(false)
  })
})

import type { AgentProcessItem } from '../components/AgentProcessLog.types'
import type { ChangeEntry } from './changeSummary'
import {
  changeKindOf,
  extractChangeDetail,
  extractChangeOutcomes,
  extractChangeTarget,
  formatChangeProperties,
  groupChanges,
  isReversibleTool,
  summarizeChanges
} from './changeSummary'

const RISKS = {
  ue_spawn_actor: 'mutating',
  blueprint_apply_graph: 'mutating',
  delete_actor: 'destructive',
  run_shell_command: 'destructive',
  read_local_file: 'safe'
} as const

function call(name: string, args: Record<string, unknown>): AgentProcessItem {
  return {
    type: 'tool-call',
    data: { id: `c-${name}`, function: { name, arguments: JSON.stringify(args) } },
    timestamp: 1
  }
}

function result(toolName: string, isError = false): AgentProcessItem {
  return { type: 'tool-result', data: { toolName, isError, result: {} }, timestamp: 2 }
}

/** 带返回值的结果项 —— 「真改了谁、真写进去了什么」只有它知道 */
function resultWith(toolName: string, payload: unknown, isError = false): AgentProcessItem {
  return { type: 'tool-result', data: { toolName, isError, result: payload }, timestamp: 2 }
}

describe('changeSummary', () => {
  it('keeps only the calls that actually change something', () => {
    const items = [
      call('read_local_file', { path: 'D:/notes.md' }),
      result('read_local_file'),
      call('blueprint_apply_graph', { blueprintPath: '/Game/BP_Weapon' }),
      result('blueprint_apply_graph')
    ]

    const changes = summarizeChanges(items, RISKS)

    expect(changes).toHaveLength(1)
    expect(changes[0]).toEqual({
      toolName: 'blueprint_apply_graph',
      risk: 'mutating',
      target: '/Game/BP_Weapon',
      reversible: true,
      failed: false
    })
  })

  it('marks a failed call so it is not read as an applied change', () => {
    const items = [call('delete_actor', { actorName: 'Cube' }), result('delete_actor', true)]

    expect(summarizeChanges(items, RISKS)[0]).toMatchObject({ failed: true, risk: 'destructive' })
  })

  it('pairs repeated calls of the same tool with their results in order', () => {
    const items = [
      call('ue_spawn_actor', { name: 'A' }),
      call('ue_spawn_actor', { name: 'B' }),
      result('ue_spawn_actor', false),
      result('ue_spawn_actor', true)
    ]

    const changes = summarizeChanges(items, RISKS)

    expect(changes.map((change) => [change.target, change.failed])).toEqual([
      ['A', false],
      ['B', true]
    ])
  })

  /**
   * 本地命令行照常进台账 —— 它落盘给「用量」页统计。只是不上「本轮改动」
   * 面板，那一步在 `groupChanges()` 里做（见下面「聚合时才滤掉」那条）。
   */
  it('本地命令行照常记进台账，带着命令原文和不可回滚', () => {
    const items = [
      call('run_shell_command', { command: 'where ffmpeg' }),
      result('run_shell_command'),
      call('blueprint_apply_graph', { blueprintPath: '/Game/BP_Weapon' }),
      result('blueprint_apply_graph')
    ]

    const changes = summarizeChanges(items, RISKS)

    expect(changes.map((change) => change.toolName)).toEqual([
      'run_shell_command',
      'blueprint_apply_graph'
    ])
    expect(changes[0]).toMatchObject({ detail: 'where ffmpeg', reversible: false })
    expect(isReversibleTool('blueprint_apply_graph')).toBe(true)
  })

  it('ignores tools the risk table does not know', () => {
    expect(summarizeChanges([call('mystery_tool', {})], RISKS)).toEqual([])
  })

  it('picks the first target-looking argument, or nothing', () => {
    expect(extractChangeTarget({ blueprintPath: '/Game/BP' })).toBe('/Game/BP')
    expect(extractChangeTarget({ note: 'hi', path: ' D:/a.txt ' })).toBe('D:/a.txt')
    expect(extractChangeTarget({ count: 3 })).toBe('')
    expect(extractChangeTarget(undefined)).toBe('')
  })

  it('名字和目标文件夹分开传时拼成资产路径', () => {
    // material_create 收 material_name + destination_path，其余材质工具收
    // 拼好的 material_path。不拼，同一个材质会在清单上占两行
    expect(
      extractChangeTarget({ material_name: 'M_GlowBreath', destination_path: '/Game/GlowDemo' })
    ).toBe('/Game/GlowDemo/M_GlowBreath')
    expect(
      extractChangeTarget({ instance_name: 'MI_Wood', destination_path: '/Game/Materials/' })
    ).toBe('/Game/Materials/MI_Wood')
  })

  it('只给名字时原样返回 —— 拼不出来就别编一个目录', () => {
    expect(extractChangeTarget({ material_name: 'M_GlowBreath' })).toBe('M_GlowBreath')
  })

  it('新建关卡的路径在 save_as 里', () => {
    expect(extractChangeTarget({ save_as: '/Game/Maps/NewLevel' })).toBe('/Game/Maps/NewLevel')
  })

  it('spawn 的目标在 instances 里，不拆开清单上只剩「创建 Actor」四个字', () => {
    expect(extractChangeTarget({ instances: [{ asset_id: 'Cube', name: 'GlowSphere' }] })).toBe(
      'GlowSphere'
    )
    expect(extractChangeTarget({ instances: [{ asset_id: '/Game/Meshes/SM_Rock' }] })).toBe(
      '/Game/Meshes/SM_Rock'
    )
  })
})

/**
 * MCP 的 `call_tool` 是个派发器 —— 它自己永远叫这个名字，真正干了什么在参数里。
 * 不拆开的话，一轮里改了 Niagara、改了 PCG、改了动画，清单上会是三行
 * 一模一样的「call_tool」，等于没写。
 */
describe('MCP 改动', () => {
  it('认得出 MCP 来的改动', () => {
    expect(isMcpChange({ toolName: 'mcp_ue-official_call_tool' })).toBe(true)
    expect(isMcpChange({ toolName: 'ue_spawn_actor' })).toBe(false)
  })

  it('target 取的是派发过去的那个工具，不是 call_tool', () => {
    expect(
      extractChangeTarget({
        toolset_name: 'NiagaraToolsets.NiagaraToolset_System',
        tool_name: 'create_system'
      })
    ).toBe('NiagaraToolset_System.create_system')
  })

  it('工具集名只取后半段 —— 前半段是插件名，用户不看那个', () => {
    const target = extractChangeTarget({
      toolset_name: 'EditorToolset.EditorAppToolset',
      tool_name: 'select_actors'
    })
    expect(target).toBe('EditorAppToolset.select_actors')
    expect(target).not.toContain('EditorToolset.')
  })

  it('没有工具集名时只显示工具名', () => {
    expect(extractChangeTarget({ tool_name: 'list_toolsets' })).toBe('list_toolsets')
  })

  it('派发信息优先于通用的 name/path —— call_tool 的 name 往往是别的东西', () => {
    expect(extractChangeTarget({ name: 'call_tool', tool_name: 'create_system' })).toBe(
      'create_system'
    )
  })

  it('不是 MCP 调用时不受影响', () => {
    expect(extractChangeTarget({ blueprintPath: '/Game/BP' })).toBe('/Game/BP')
  })
})

describe('changeLabelKey', () => {
  it('拼出 i18n key', () => {
    expect(changeLabelKey('ue_spawn_actor')).toBe('assistant.changes.tools.ue_spawn_actor')
  })
})

/**
 * 聚合。清单要回答的是「我的工程里变了几样东西」，而原来一次调用一行答的是
 * 「agent 干了多少步」—— 做一个材质三十多步，这两个数没有关系。
 */
describe('groupChanges', () => {
  function entry(over: Partial<ChangeEntry> & { toolName: string }): ChangeEntry {
    return { risk: 'mutating', target: '', reversible: true, failed: false, ...over }
  }

  /**
   * 真机截图那一轮：新建关卡 → 建材质 → 搭图 → 编译 → 整理 → 放 Actor →
   * 保存 → 保存关卡 → 试玩。用户眼里只发生了三件事（多了一个关卡、一个材质、
   * 一个 Actor），清单就该是三行。
   */
  const REAL_TURN: ChangeEntry[] = [
    entry({ toolName: 'ue_new_level', target: '/Game/GlowDemo/NewLevel' }),
    entry({ toolName: 'material_create', target: 'M_GlowBreath' }),
    ...Array.from({ length: 11 }, () =>
      entry({ toolName: 'material_add_node', target: '/Game/GlowDemo/M_GlowBreath' })
    ),
    entry({ toolName: 'material_compile', target: '/Game/GlowDemo/M_GlowBreath' }),
    entry({ toolName: 'material_tidy_graph', target: '/Game/GlowDemo/M_GlowBreath' }),
    entry({ toolName: 'ue_spawn_actor', target: 'GlowSphere' }),
    entry({ toolName: 'ue_save', target: '' }),
    entry({ toolName: 'ue_save', target: '' }),
    entry({ toolName: 'ue_save_level', target: '' }),
    entry({ toolName: 'ue_playtest', target: '' })
  ]

  it('截图那一轮：19 次调用 → 3 行，因为用户眼里只多了三样东西', () => {
    const groups = groupChanges(REAL_TURN)

    expect(groups.map((group) => [group.kind, group.target, group.action])).toEqual([
      ['level', '/Game/GlowDemo/NewLevel', 'created'],
      ['material', '/Game/GlowDemo/M_GlowBreath', 'created'],
      ['actor', 'GlowSphere', 'created']
    ])
  })

  it('同一个材质不会占两行 —— 建的时候只给名字，之后给完整路径', () => {
    const groups = groupChanges(REAL_TURN).filter((group) => group.kind === 'material')

    expect(groups).toHaveLength(1)
    // 并到带路径的那一份上，行上才有目录可显示、才能在编辑器里打开
    expect(groups[0].target).toBe('/Game/GlowDemo/M_GlowBreath')
    expect(groups[0].steps.map((step) => step.toolName)).toContain('material_create')
  })

  it('保存 / 试玩不单独占行 —— 用户在自己工程里指不出「保存」这个东西', () => {
    const keys = groupChanges(REAL_TURN).map((group) => group.key)

    expect(keys).not.toContain('ue_save')
    expect(keys).not.toContain('ue_save_level')
    expect(keys).not.toContain('ue_playtest')
  })

  it('编译和整理连线并进那个资产的展开区，不丢也不占行', () => {
    const material = groupChanges(REAL_TURN).find((group) => group.kind === 'material')!

    expect(material.steps.map((step) => step.toolName)).toEqual([
      'material_create',
      'material_add_node',
      'material_compile',
      'material_tidy_graph'
    ])
  })

  it('不可逆的操作一律占一行，哪怕它长得像内务', () => {
    // ue_open_level / ue_restart_editor 会丢掉用户没保存的改动。
    // 漏报一次不可逆操作，比多显示一行糟得多
    const groups = groupChanges([
      entry({ toolName: 'ue_open_level', risk: 'destructive', target: '/Game/Maps/Other' }),
      entry({ toolName: 'ue_fixup_redirectors', risk: 'destructive' })
    ])

    expect(groups.map((group) => group.key)).toEqual(['/Game/Maps/Other', 'ue_fixup_redirectors'])
  })

  it('整轮只有内务时清单为空 —— 用户说「保存一下」不需要一张台账', () => {
    expect(groupChanges([entry({ toolName: 'ue_save' }), entry({ toolName: 'ue_save' })])).toEqual(
      []
    )
  })

  it('内务跑在编辑之前也不会凭空多出一行', () => {
    const groups = groupChanges([
      entry({ toolName: 'material_compile', target: '/Game/M_A' }),
      entry({ toolName: 'material_add_node', target: '/Game/M_A' })
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].steps.map((step) => step.toolName)).toEqual([
      'material_compile',
      'material_add_node'
    ])
  })

  it('同名不同目录的两个资产不合并 —— 分不清裸名字指哪个就别猜', () => {
    const groups = groupChanges([
      entry({ toolName: 'material_add_node', target: '/Game/A/M_X' }),
      entry({ toolName: 'material_add_node', target: '/Game/B/M_X' }),
      entry({ toolName: 'material_create', target: 'M_X' })
    ])

    expect(groups.map((group) => group.target)).toEqual(['/Game/A/M_X', '/Game/B/M_X', 'M_X'])
  })

  /** 截图里那一轮：建材质 → 加十个节点 → 连九条线 → 编译 → 整理连线 */
  const MATERIAL_TURN: ChangeEntry[] = [
    entry({ toolName: 'material_create', target: '/Game/GlowDemo/M_GlowBreath' }),
    ...Array.from({ length: 10 }, () =>
      entry({ toolName: 'material_add_node', target: '/Game/GlowDemo/M_GlowBreath' })
    ),
    ...Array.from({ length: 9 }, () =>
      entry({ toolName: 'material_connect_pins', target: '/Game/GlowDemo/M_GlowBreath' })
    ),
    entry({ toolName: 'material_compile', target: '/Game/GlowDemo/M_GlowBreath' }),
    entry({ toolName: 'material_tidy_graph', target: '/Game/GlowDemo/M_GlowBreath' })
  ]

  it('三十多次调用聚合成一行，因为用户只多了一个材质', () => {
    const groups = groupChanges(MATERIAL_TURN)

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      target: '/Game/GlowDemo/M_GlowBreath',
      kind: 'material',
      action: 'created',
      stepCount: 22,
      failedCount: 0,
      local: false
    })
  })

  it('施工步骤没有丢，只是同名的合并计数', () => {
    const steps = groupChanges(MATERIAL_TURN)[0].steps

    expect(steps.map((step) => [step.toolName, step.count])).toEqual([
      ['material_create', 1],
      ['material_add_node', 10],
      ['material_connect_pins', 9],
      ['material_compile', 1],
      ['material_tidy_graph', 1]
    ])
  })

  it('不同资产分开，各算各的', () => {
    const groups = groupChanges([
      entry({ toolName: 'material_create', target: '/Game/M_A' }),
      entry({ toolName: 'blueprint_apply_graph', target: '/Game/BP_B' }),
      entry({ toolName: 'material_compile', target: '/Game/M_A' })
    ])

    expect(groups.map((group) => [group.target, group.kind, group.action])).toEqual([
      ['/Game/M_A', 'material', 'created'],
      ['/Game/BP_B', 'blueprint', 'modified']
    ])
  })

  it('没建过就是「修改」——「新建」只认资产级的新建工具', () => {
    // 加变量建的是蓝图**里面**的东西，那个蓝图本身是被改了，不是被新建
    const groups = groupChanges([
      entry({ toolName: 'blueprint_add_variable', target: '/Game/BP_Door' })
    ])

    expect(groups[0].action).toBe('modified')
  })

  it('先建后删，净结果是删掉了', () => {
    const groups = groupChanges([
      entry({ toolName: 'ue_spawn_actor', target: 'Cube' }),
      entry({ toolName: 'ue_destroy_actor', target: 'Cube' })
    ])

    expect(groups[0].action).toBe('deleted')
  })

  it('失败的那一步不改变净结果', () => {
    const groups = groupChanges([
      entry({ toolName: 'ue_spawn_actor', target: 'Cube' }),
      entry({ toolName: 'ue_destroy_actor', target: 'Cube', failed: true })
    ])

    expect(groups[0]).toMatchObject({ action: 'created', failedCount: 1, stepCount: 2 })
  })

  it('取不到目标的万能工具按工具名归一组，别摊成六行一样的字', () => {
    const groups = groupChanges([
      entry({ toolName: 'ue_run_python_script' }),
      entry({ toolName: 'ue_run_python_script' }),
      entry({ toolName: 'ue_run_python_script' })
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ key: 'ue_run_python_script', target: '', kind: '' })
    expect(groups[0].steps[0].count).toBe(3)
  })

  it('本地文件单独标出来 —— 那些能打开、能定位', () => {
    const groups = groupChanges([
      entry({ toolName: 'write_local_file', target: 'D:/proj/说明.html' }),
      entry({ toolName: 'edit_local_file', target: 'D:/proj/说明.html' })
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ local: true, kind: 'file', stepCount: 2 })
  })

  it('撤不回去的步数按组算，失败的那步没干成也就没什么可撤的', () => {
    const groups = groupChanges([
      entry({ toolName: 'browser_interact', target: 'ue5box.com', reversible: false }),
      entry({ toolName: 'browser_interact', target: 'ue5box.com', reversible: false, failed: true })
    ])

    expect(groups[0]).toMatchObject({ irreversibleCount: 1, failedCount: 1, stepCount: 2 })
  })

  it('本地命令行聚合时才滤掉 —— 台账留着给统计，面板上不显示', () => {
    const groups = groupChanges([
      entry({ toolName: 'run_shell_command', detail: 'ls -l', reversible: false }),
      entry({ toolName: 'material_add_node', target: '/Game/M_A' })
    ])

    expect(groups.map((group) => group.target)).toEqual(['/Game/M_A'])
  })

  it('看不出类型的内务操作打头时，类型由后面的步骤补上', () => {
    const groups = groupChanges([
      entry({ toolName: 'ue_save', target: '/Game/M_A' }),
      entry({ toolName: 'material_set_param', target: '/Game/M_A' })
    ])

    expect(groups[0].kind).toBe('material')
  })
})

describe('changeKindOf', () => {
  it('按前缀认类型，第一条命中的算数', () => {
    // material_ 必须先撞上，不能落到后面的 ue_set_property
    expect(changeKindOf('material_set_property')).toBe('material')
    expect(changeKindOf('ue_set_property')).toBe('actor')
    expect(changeKindOf('ue_save_level')).toBe('level')
    // 素材库的删除也进台账 —— 用户得看得见 agent 删了他的东西
    expect(changeKindOf('delete_assets')).toBe('asset')
  })

  it('认不出来就不标 —— 一个错的类型比没有类型更误导', () => {
    expect(changeKindOf('ue_run_console_command')).toBe('')
    expect(changeKindOf('mcp_ue-official_call_tool')).toBe('')
  })
})

/**
 * 浏览器操作的台账。
 *
 * 用户该看得见 agent 打开了哪个网站、点了什么，但**看不到他输入的内容** ——
 * 那些在审批弹窗里已经当场看过一次，没有理由再长期挂在界面上。
 */
describe('浏览器操作', () => {
  const BROWSER_RISKS = {
    // 打开网页是只读的：它什么都没改，不该进「本轮改动」
    browser_open: 'safe',
    browser_interact: 'mutating',
    browser_read: 'safe',
    browser_navigate: 'safe',
    browser_screenshot: 'safe'
  } as const

  it('打开网页不进台账 —— 它什么都没改，过程记录里有就够了', () => {
    const changes = summarizeChanges(
      [call('browser_open', { url: 'https://www.electronjs.org/docs' }), result('browser_open')],
      BROWSER_RISKS
    )

    expect(changes).toEqual([])
  })

  it('操作网页显示元素标签，不显示输入内容', () => {
    const changes = summarizeChanges(
      [
        call('browser_interact', { action: 'type', ref: 2, label: '搜索', value: '我的密码' }),
        result('browser_interact')
      ],
      BROWSER_RISKS
    )

    expect(changes[0].target).toBe('搜索')
    expect(JSON.stringify(changes)).not.toContain('我的密码')
  })

  it('点出去的那一下撤不回来 —— 它发生在别人的服务器上', () => {
    expect(isReversibleTool('browser_interact')).toBe(false)
  })

  it('操作网页归到「网页」这一类', () => {
    expect(changeKindOf('browser_interact')).toBe('web')
  })

  it('读取、滚动、截图不进台账', () => {
    const changes = summarizeChanges(
      [
        call('browser_read', { mode: 'content' }),
        result('browser_read'),
        call('browser_screenshot', {}),
        result('browser_screenshot')
      ],
      BROWSER_RISKS
    )

    expect(changes).toEqual([])
  })
})

/**
 * 引擎命令 / 脚本的台账。
 *
 * 只写「执行控制台命令 ×2」的话，用户一样也答不出来：跑的是哪两条？
 * 对工程干了什么？命令原文必须进台账。
 *
 * 用户自己电脑上的命令行（`run_shell_command`）是另一回事：它照常进台账，
 * 只是聚合时不上面板，见上面那两条。
 */
describe('引擎命令与脚本', () => {
  const SHELL_RISKS = {
    run_shell_command: 'destructive',
    ue_run_python_script: 'destructive',
    ue_run_console_command: 'destructive'
  } as const

  it('命令原文进 detail，target 保持为空 —— 命令不是工程里的路径', () => {
    const changes = summarizeChanges(
      [call('ue_run_console_command', { command: 'stat fps' }), result('ue_run_console_command')],
      SHELL_RISKS
    )

    expect(changes[0]).toMatchObject({ detail: 'stat fps', target: '' })
  })

  it('脚本同理', () => {
    const changes = summarizeChanges(
      [
        call('ue_run_python_script', { script: 'print(1)' }),
        result('ue_run_python_script'),
        call('ue_run_console_command', { command: 'stat fps' }),
        result('ue_run_console_command')
      ],
      SHELL_RISKS
    )

    expect(changes.map((change) => change.detail)).toEqual(['print(1)', 'stat fps'])
  })

  it('本地命令行进得了台账，但分不到这一区的行里', () => {
    const changes = summarizeChanges(
      [call('run_shell_command', { command: 'git status' }), result('run_shell_command')],
      SHELL_RISKS
    )

    expect(changes).toHaveLength(1)
    expect(groupChanges(changes)).toEqual([])
  })

  it('两条不同的命令是两行，各带各的命令原文', () => {
    const groups = groupChanges([
      {
        toolName: 'ue_run_console_command',
        risk: 'destructive',
        target: '',
        detail: 'stat fps',
        reversible: true,
        failed: false
      },
      {
        toolName: 'ue_run_console_command',
        risk: 'destructive',
        target: '',
        detail: 'r.ScreenPercentage 50',
        reversible: true,
        failed: false
      }
    ])

    expect(groups).toHaveLength(2)
    expect(groups.map((group) => group.steps[0].detail)).toEqual([
      'stat fps',
      'r.ScreenPercentage 50'
    ])
  })

  it('同一条命令跑两遍才合并成一条 ×2', () => {
    const groups = groupChanges([
      {
        toolName: 'ue_run_console_command',
        risk: 'destructive',
        target: '',
        detail: 'stat fps',
        reversible: true,
        failed: false
      },
      {
        toolName: 'ue_run_console_command',
        risk: 'destructive',
        target: '',
        detail: 'stat fps',
        reversible: true,
        failed: false
      }
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].steps[0]).toMatchObject({ detail: 'stat fps', count: 2 })
  })

  it('没带命令参数的调用退回按工具名归组，不会因此丢掉', () => {
    const groups = groupChanges([
      {
        toolName: 'ue_run_python_script',
        risk: 'destructive',
        target: '',
        reversible: true,
        failed: false
      }
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('ue_run_python_script')
  })
})

/**
 * 插件管理的台账。
 *
 * 一个工具同时管启用和停用，不把方向抽出来，界面就永远只能说含糊的
 * 「启用/停用插件」—— 用户想知道的恰恰是「启了还是停了、动的是哪个插件」。
 * 另外它的 Query 是只读查询，混进改动台账会让用户以为插件被动过。
 */
describe('插件管理', () => {
  const PLUGIN_RISKS = { ue_manage_plugin: 'destructive' } as const

  it('插件名是 target', () => {
    expect(extractChangeTarget({ plugin_name: 'GLTFImporter', action: 'Enable' })).toBe(
      'GLTFImporter'
    )
  })

  it('Query 是只读查询，不进台账 —— 没改东西就不算改动', () => {
    const changes = summarizeChanges(
      [
        call('ue_manage_plugin', { plugin_name: 'GLTFImporter', action: 'Query' }),
        result('ue_manage_plugin'),
        // action 缺省时工具自己也是按 Query 处理
        call('ue_manage_plugin', { plugin_name: 'GLTFImporter' }),
        result('ue_manage_plugin')
      ],
      PLUGIN_RISKS
    )

    expect(changes).toEqual([])
  })

  it('启用和停用分得清：行上写哪个插件、净结果是启了还是停了', () => {
    const groups = groupChanges([
      {
        toolName: 'ue_manage_plugin',
        risk: 'destructive',
        target: 'GLTFImporter',
        detail: 'Enable',
        reversible: true,
        failed: false
      },
      {
        toolName: 'ue_manage_plugin',
        risk: 'destructive',
        target: 'PythonScriptPlugin',
        detail: 'Disable',
        reversible: true,
        failed: false
      }
    ])

    expect(groups.map((group) => [group.target, group.kind, group.action])).toEqual([
      ['GLTFImporter', 'plugin', 'enabled'],
      ['PythonScriptPlugin', 'plugin', 'disabled']
    ])
  })

  it('先停后启，净结果是它现在开着；两步都在展开区里', () => {
    const groups = groupChanges([
      {
        toolName: 'ue_manage_plugin',
        risk: 'destructive',
        target: 'GLTFImporter',
        detail: 'Disable',
        reversible: true,
        failed: false
      },
      {
        toolName: 'ue_manage_plugin',
        risk: 'destructive',
        target: 'GLTFImporter',
        detail: 'Enable',
        reversible: true,
        failed: false
      }
    ])

    expect(groups).toHaveLength(1)
    expect(groups[0].action).toBe('enabled')
    expect(groups[0].steps.map((step) => step.detail)).toEqual(['Disable', 'Enable'])
  })

  it('失败的启停不改变净结果', () => {
    const groups = groupChanges([
      {
        toolName: 'ue_manage_plugin',
        risk: 'destructive',
        target: 'GLTFImporter',
        detail: 'Disable',
        reversible: true,
        failed: true
      }
    ])

    expect(groups[0].action).toBe('modified')
    expect(groups[0].failedCount).toBe(1)
  })
})

/**
 * Actor 属性改动。
 *
 * 真机截图里这一行是「Actor 修改属性」四个字，再没有别的 —— 动的是哪个 Actor、
 * 改了哪个属性、改成了什么，一个都答不出来。原因有两层：目标埋在 `targets`
 * 第二层里顶层白名单扫不到，而「改成什么」压根没被抽取过。
 */
describe('Actor 属性与变换', () => {
  const ACTOR_RISKS = {
    ue_set_property: 'mutating',
    ue_set_transform: 'mutating',
    ue_spawn_actor: 'mutating'
  } as const

  it('目标埋在 targets 选择器里，不拆开就只剩「修改属性」四个字', () => {
    expect(extractChangeTarget({ targets: { names: ['SM_Door'] }, properties: {} })).toBe('SM_Door')
    expect(extractChangeTarget({ targets: { paths: ['/Game/Maps/L.L:PL.Cube_0'] } })).toBe(
      '/Game/Maps/L.L:PL.Cube_0'
    )
  })

  it('targets 是 JSON 字符串时照样认 —— 工具自己两种都收', () => {
    expect(extractChangeTarget({ targets: '{"names":["PointLight_1"]}' })).toBe('PointLight_1')
  })

  it('改用户选中的那些时参数里没有名字，退回空目标', () => {
    expect(extractChangeTarget({ targets: { selection: true }, properties: {} })).toBe('')
  })

  it('属性键值对拍平成一行：这才是用户想知道的「改成什么了」', () => {
    expect(formatChangeProperties({ Intensity: 10000 })).toBe('Intensity=10000')
    // 向量 / 颜色压成一组数字，键名（r/g/b）是位置约定，写出来只是噪音
    expect(formatChangeProperties({ LightColor: { r: 255, g: 0, b: 0 } })).toBe(
      'LightColor=(255, 0, 0)'
    )
    expect(formatChangeProperties({ bHidden: true, Mobility: 'Movable' })).toBe(
      'bHidden=true, Mobility=Movable'
    )
  })

  it('变换参数按嵌套路径展开，说得出改的是位置还是缩放', () => {
    expect(
      extractChangeDetail('ue_set_transform', {
        operation: { set: { location: { x: 0, y: 0, z: 100 } } }
      })
    ).toBe('set.location=(0, 0, 100)')
  })

  it('detail 有长度上限 —— 它随聊天记录进 localStorage，不封顶会撑掉存储', () => {
    const many = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`Property${i}`, 'SomeLongValue'])
    )
    const text = formatChangeProperties(many)

    expect(text.length).toBeLessThanOrEqual(121)
    expect(text.endsWith('…')).toBe(true)
  })

  it('返回值里的 updated 才是事实：报错的属性不在里面，显示的就是真生效的那些', () => {
    const changes = summarizeChanges(
      [
        call('ue_set_property', {
          targets: { names: ['PointLight_1'] },
          properties: { Intensity: 10000, NoSuchProp: 1 }
        }),
        resultWith('ue_set_property', {
          count: 1,
          actors: [
            {
              name: 'PointLight_1',
              updated: { Intensity: 10000 },
              errors: [{ property: 'NoSuchProp', error: 'not found' }]
            }
          ]
        })
      ],
      ACTOR_RISKS
    )

    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ target: 'PointLight_1', detail: 'Intensity=10000' })
    // 参数里那个没改成的属性不该出现在台账上
    expect(changes[0].detail).not.toContain('NoSuchProp')
  })

  it('一次调用改了三个 Actor 就是三行 —— 行数要等于「我的工程里变了几样东西」', () => {
    const changes = summarizeChanges(
      [
        call('ue_set_property', { targets: { selection: true }, properties: { bHidden: true } }),
        resultWith('ue_set_property', {
          count: 3,
          actors: [
            { name: 'Cube_1', updated: { bHidden: true } },
            { name: 'Cube_2', updated: { bHidden: true } },
            { name: 'Cube_3', updated: { bHidden: true } }
          ]
        })
      ],
      ACTOR_RISKS
    )

    expect(groupChanges(changes).map((group) => group.target)).toEqual([
      'Cube_1',
      'Cube_2',
      'Cube_3'
    ])
  })

  it('一个 Actor 上什么都没改成时单独标失败，别让它混在成功的里面', () => {
    const changes = summarizeChanges(
      [
        call('ue_set_property', {
          targets: { names: ['A', 'B'] },
          properties: { Intensity: 5 }
        }),
        resultWith('ue_set_property', {
          count: 1,
          actors: [
            { name: 'A', updated: { Intensity: 5 } },
            { name: 'B', updated: {}, errors: [{ property: 'Intensity', error: 'read-only' }] }
          ]
        })
      ],
      ACTOR_RISKS
    )

    expect(changes.map((change) => [change.target, change.failed])).toEqual([
      ['A', false],
      ['B', true]
    ])
  })

  it('动的东西太多就退回一行，宁可粗也不要一堵墙', () => {
    const actors = Array.from({ length: 30 }, (_, i) => ({
      name: `Rock_${i}`,
      updated: { bHidden: true }
    }))

    expect(extractChangeOutcomes('ue_set_property', { actors })).toEqual([])

    const changes = summarizeChanges(
      [
        call('ue_set_property', {
          targets: { filter: { class: 'StaticMeshActor' } },
          properties: { bHidden: true }
        }),
        resultWith('ue_set_property', { count: 30, actors })
      ],
      ACTOR_RISKS
    )

    // 退回的那一行仍然带着参数里的属性清单，不会变回黑盒
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ target: '', detail: 'bHidden=true' })
  })

  it('调用失败时没有返回值可读，退回参数里的目标，整行标未生效', () => {
    const changes = summarizeChanges(
      [
        call('ue_set_property', { targets: { names: ['SM_Door'] }, properties: { Intensity: 1 } }),
        result('ue_set_property', true)
      ],
      ACTOR_RISKS
    )

    expect(changes).toEqual([
      {
        toolName: 'ue_set_property',
        risk: 'mutating',
        target: 'SM_Door',
        detail: 'Intensity=1',
        reversible: true,
        failed: true
      }
    ])
  })

  it('spawn 出来的名字以引擎为准 —— 它会自己改名，参数里那个未必是最终的', () => {
    const changes = summarizeChanges(
      [
        call('ue_spawn_actor', { instances: [{ asset_id: 'Cube', name: 'Cube' }] }),
        resultWith('ue_spawn_actor', { count: 1, created: [{ name: 'Cube_2', path: '/Game/L' }] })
      ],
      ACTOR_RISKS
    )

    expect(changes[0].target).toBe('Cube_2')
    expect(groupChanges(changes)[0].action).toBe('created')
  })

  it('spawn 失败的那几项是 null，跳过它们', () => {
    expect(
      extractChangeOutcomes('ue_spawn_actor', { created: [null, { name: 'Cube_2' }, null] })
    ).toEqual([{ target: 'Cube_2' }])
  })

  it('没有返回值的历史消息照旧走参数那套，不会因此丢行', () => {
    const changes = summarizeChanges(
      [
        call('ue_set_property', { targets: { names: ['SM_Door'] }, properties: { Intensity: 1 } }),
        result('ue_set_property')
      ],
      ACTOR_RISKS
    )

    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ target: 'SM_Door', detail: 'Intensity=1', failed: false })
  })

  it('认不出返回值形状的工具不受影响', () => {
    expect(extractChangeOutcomes('material_create', { actors: [{ name: 'X' }] })).toEqual([])
    expect(extractChangeOutcomes('ue_set_property', undefined)).toEqual([])
    expect(extractChangeOutcomes('ue_set_property', 'ok')).toEqual([])
  })
})
