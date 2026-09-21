/**
 * @vitest-environment node
 *
 * 运行时信封的契约测试。
 *
 * 这里守的是一条**真机上已经发生过**的故障（会话
 * cb5dedbe-974f-4995-b56d-af7646870188）：前一天 22:13 的一次
 * `ue_session_health` 回了 `not_running`；次日 13:04:48 插件重新连上并一直没断；
 * 13:07:09 用户问「我们项目里有啥」，模型引用那条隔夜结论，对用户说
 * 「编辑器现在没跑，引擎工具用不了」，然后连开二十多次 `list_local_dir` 扫磁盘。
 *
 * 所以下面几条不是风格测试：**改坏了没有任何测试会红，只会让模型再对用户
 * 说一次假话。**
 */

import { describe, expect, it } from 'vitest'

import {
  HEALTH_SCOPE_FIELD,
  LEGACY_HEALTH_MARKER,
  RUNTIME_ENVELOPE_RULES,
  SESSION_HEALTH_TOOL_NAME,
  createRuntimeScopeId,
  formatLocalNow,
  formatRuntimeEnvelope,
  getRuntimeScopeId,
  lastRuntimeScopeId,
  markLegacyHealthResults,
  runWithRuntimeScope,
  withRuntimeEnvelope,
  type RuntimeEnvelope
} from './runtimeEnvelope'

const base: RuntimeEnvelope = {
  runtimeScopeId: 'rt-abc123',
  observedAt: '2026-09-01 13:07:09 UTC+08:00 (Tuesday)',
  engineLink: 'target'
}

describe('formatRuntimeEnvelope', () => {
  it('带上作用域、观测时刻和连接状态', () => {
    const text = formatRuntimeEnvelope(base)

    expect(text).toContain('<runtime-status scope="rt-abc123">')
    expect(text).toContain('2026-09-01 13:07:09 UTC+08:00 (Tuesday)')
    expect(text).toContain('engine_link: target')
    expect(text.trimEnd().endsWith('</runtime-status>')).toBe(true)
  })

  /**
   * 块里装着两种东西：刚查过的，和记在册上没重新查的。
   *
   * 以前一句「机器核对过的事实」把两者盖在一起 —— 袋子标错了还要求模型严谨，
   * 它只能二选一：全信（断言目录还在），或全不信（手上有路径也要再查一遍）。
   * 真机上两种相反的错都出过。所以这一行必须在，而且必须点名只有谁被查过。
   */
  it('明写只有 engine_link 是刚查的，其余都是记录', () => {
    const text = formatRuntimeEnvelope(base)

    expect(text).toContain('checked_now: engine_link')
    expect(text).toContain('was not re-checked')
  })

  /**
   * 时刻必须自己占一行、键名必须叫 `now`。
   *
   * 真机上它只出现在 `checked_now` 的括号里，而且是 UTC：用户凌晨 1:54 问
   * 「现在几点」，模型眼前是前一天的 17:54Z，既要补时区又要跨日 —— 它两件都
   * 没做，编了个「14点03分」，还加一句「和网络授时一致」。
   * 所以这里盯的不是「有没有时间」，是「模型能不能一眼认出这是钟」。
   */
  it('时刻单独成行，键名是 now', () => {
    const line = formatRuntimeEnvelope(base)
      .split('\n')
      .find((row) => row.startsWith('now: '))

    expect(line).toContain('2026-09-01 13:07:09 UTC+08:00 (Tuesday)')
    expect(line).toContain('local clock')
  })
  it('一个都没连时写 none', () => {
    expect(formatRuntimeEnvelope({ ...base, engineLink: 'none' })).toContain('engine_link: none')
  })

  /**
   * 「这台机器连着」和「这条会话够得着」是两件事，但**不该由模型去合取推导**。
   *
   * 以前是两个布尔，(false, true) 才表示「连着，只是没连你的工程」——
   * 于是提示词里要写一句话教它怎么推。三个状态直接说出来就没有那句话了。
   * 印不出这个区别的话，模型会去劝一个明明连着引擎的人装 UnrealAgentLink。
   */
  it('机器连着但这条会话够不着时，直接印 other_project', () => {
    const text = formatRuntimeEnvelope({
      ...base,
      engineLink: 'other_project',
      sessionProject: { name: 'test222' },
      outOfScopeProjects: ['UALinkDev55']
    })

    expect(text).toContain('engine_link: other_project')
    expect(text).toContain('session_project: test222')
    expect(text).toContain('other_connected_projects: UALinkDev55')
  })

  it('没有别的工程连着时明确写 (none)，不留一个空值让模型去猜', () => {
    expect(formatRuntimeEnvelope(base)).toContain('other_connected_projects: (none)')
    expect(formatRuntimeEnvelope({ ...base, outOfScopeProjects: [] })).toContain('(none)')
  })

  // 工程字段是引擎那边报上来的，缺字段是常态
  it('工程信息不全时跳过缺的字段，不印 undefined', () => {
    const text = formatRuntimeEnvelope({
      ...base,
      targetProject: { name: 'MyGame' },
      sessionProject: { name: 'MyGame' }
    })

    expect(text).toContain('target_project: MyGame')
    expect(text).not.toContain('undefined')
  })

  it('工程信息齐全时把引擎版本和路径一起给出去', () => {
    const text = formatRuntimeEnvelope({
      ...base,
      targetProject: {
        name: 'UALinkDev55',
        engineVersion: '5.5',
        pathOnRecord: 'I:/UnrealAgent/UALinkDev55'
      }
    })

    // 键名叫 path_on_record 而不是 at/path：这是登记值，不是「刚确认过目录还在」。
    // 名字自己带着限定词，提示词里就不必再花一句话解释这件事。
    expect(text).toContain(
      'target_project: UALinkDev55 (UE 5.5), path_on_record I:/UnrealAgent/UALinkDev55'
    )
  })

  /**
   * 信封每一轮都要付一次 token，而且**永远留在历史里**。
   * 一次加一行的诱惑很大，但一百轮之后那就是一百行。
   */
  it('保持精简 —— 十行以内', () => {
    const text = formatRuntimeEnvelope({
      ...base,
      targetProject: { name: 'A', engineVersion: '5.5', pathOnRecord: '/a' },
      sessionProject: { name: 'A', engineVersion: '5.5', pathOnRecord: '/a' },
      outOfScopeProjects: ['B', 'C']
    })

    expect(text.split('\n').length).toBeLessThanOrEqual(10)
  })
})

describe('withRuntimeEnvelope', () => {
  it('信封在前、用户原话在后，原话一个字不动', () => {
    const combined = withRuntimeEnvelope('我们项目里有啥', base)

    expect(combined.startsWith('<runtime-status')).toBe(true)
    expect(combined.endsWith('我们项目里有啥')).toBe(true)
  })

  // 无头场景（调试入口、以后的定时任务）没有信封，不该凭空多出一段
  it('没有信封时原样返回', () => {
    expect(withRuntimeEnvelope('你好', undefined)).toBe('你好')
  })
})

describe('运行时作用域', () => {
  it('作用域 id 每次都不一样', () => {
    expect(createRuntimeScopeId()).not.toBe(createRuntimeScopeId())
  })

  it('在作用域里读得到，作用域外读不到', () => {
    expect(getRuntimeScopeId()).toBeUndefined()
    expect(runWithRuntimeScope('rt-1', () => getRuntimeScopeId())).toBe('rt-1')
    expect(getRuntimeScopeId()).toBeUndefined()
  })

  /**
   * 并发会话必须各读各的。
   *
   * 这正是它用 AsyncLocalStorage 而不是模块级变量的全部理由（同
   * `projectTargetContext.ts`）：两条会话同时执行时，模块级变量会被后启动的
   * 那个覆盖掉，于是 A 会话里的健康检查盖上 B 会话的戳 —— 而那种错
   * 只会表现为「模型偶尔不信自己刚拿到的结果」，根本查不出来。
   */
  it('并发的两条执行流互不干扰', async () => {
    const observe = async (id: string): Promise<string | undefined> =>
      runWithRuntimeScope(id, async () => {
        await new Promise((resolve) => setTimeout(resolve, id === 'rt-slow' ? 20 : 1))
        return getRuntimeScopeId()
      })

    expect(await Promise.all([observe('rt-slow'), observe('rt-fast')])).toEqual([
      'rt-slow',
      'rt-fast'
    ])
  })
})

describe('markLegacyHealthResults', () => {
  const healthResult = (text: string): unknown => ({
    role: 'toolResult',
    toolName: SESSION_HEALTH_TOOL_NAME,
    toolCallId: 'c1',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 0
  })

  it('给没有作用域戳的存量结果打上历史标记', () => {
    const marked = markLegacyHealthResults([healthResult('state=not_running\n\n编辑器没在跑。')])
    const text = (marked[0] as { content: { text: string }[] }).content[0].text

    expect(text).toContain(LEGACY_HEALTH_MARKER)
    expect(text).toContain('编辑器没在跑。')
  })

  it('已经带戳的结果一个字都不动', () => {
    const messages = [healthResult(`state=connected\n${HEALTH_SCOPE_FIELD}=rt-abc\n\n连着。`)]

    expect(markLegacyHealthResults(messages)).toBe(messages)
  })

  it('别的工具的结果不碰', () => {
    const messages = [
      {
        role: 'toolResult',
        toolName: 'list_local_dir',
        content: [{ type: 'text', text: 'state=not_running 出现在正文里也不算' }]
      }
    ]

    expect(markLegacyHealthResults(messages)).toBe(messages)
  })

  it('没有可标的东西时返回原数组本身 —— 每次请求都跑，不能白造数组', () => {
    const messages = [{ role: 'user', content: '你好' }]

    expect(markLegacyHealthResults(messages)).toBe(messages)
  })

  /**
   * **确定性是这条改写能被允许的前提。**
   *
   * 它每次模型请求都跑一遍。只要输出有一点抖动（带上时间、带上随机数），
   * 每一轮渲染出来的前缀就都不一样，厂商的 Prompt Cache 一次也命中不了 ——
   * 那就把「修 bug」变成了「顺手把缓存打掉」。
   */
  it('同一份输入两次得到逐字节相同的输出', () => {
    const input = (): unknown[] => [healthResult('state=not_running\n\n没在跑。')]

    expect(JSON.stringify(markLegacyHealthResults(input()))).toBe(
      JSON.stringify(markLegacyHealthResults(input()))
    )
  })

  it('不改动原消息对象 —— 盘上那份和内存里那份是同一个引用', () => {
    const original = healthResult('state=not_running')
    markLegacyHealthResults([original])

    expect((original as { content: { text: string }[] }).content[0].text).toBe('state=not_running')
  })
})

describe('lastRuntimeScopeId', () => {
  const userMessage = (text: string): unknown => ({ role: 'user', content: text })

  it('取最后一个信封的 id，不是第一个', () => {
    const messages = [
      userMessage(withRuntimeEnvelope('第一轮', { ...base, runtimeScopeId: 'rt-old' })),
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      userMessage(withRuntimeEnvelope('第二轮', { ...base, runtimeScopeId: 'rt-new' }))
    ]

    expect(lastRuntimeScopeId(messages)).toBe('rt-new')
  })

  it('content 是块数组时也认得出来', () => {
    const messages = [
      {
        role: 'user',
        content: [{ type: 'text', text: withRuntimeEnvelope('看图', base) }]
      }
    ]

    expect(lastRuntimeScopeId(messages)).toBe('rt-abc123')
  })

  // 本次改动之前的存量会话没有信封。整套机制对它们静默失效，行为退回改动前
  it('没有信封时返回 undefined，而不是编一个出来', () => {
    expect(lastRuntimeScopeId([userMessage('你好')])).toBeUndefined()
    expect(lastRuntimeScopeId([])).toBeUndefined()
  })
})

/**
 * 规则正文。
 *
 * 这几条是整套机制里唯一真正约束模型行为的部分，删掉任何一条都不会让别的测试
 * 变红。所以逐条钉住它们说的那件事。
 */
describe('RUNTIME_ENVELOPE_RULES', () => {
  const rules = RUNTIME_ENVELOPE_RULES.join('\n')

  /**
   * 分两层：先说怎么理解事实，再说据此怎么动手。
   *
   * 混在一层的时候这一段没法被评估 —— 你没法问「它完整吗」，因为它同时装着
   * 三份互不相干的契约（时效模型、工具行为、工程类型）。真机上的代价是加规则
   * 的人只会往末尾追加，而不会去想新加的那条属于哪一层、和哪一条冲突。
   */
  it('分成「怎么理解事实」和「据此怎么动手」两层', () => {
    expect(rules).toContain('Reading these facts:')
    expect(rules).toContain('Acting on them:')
    expect(rules.indexOf('Reading these facts:')).toBeLessThan(rules.indexOf('Acting on them:'))
  })

  /**
   * 三类事实各说各的，不能互相顶替。
   *
   * 真机上的混淆：把「登记了路径」当成「刚确认过目录还在」，把「没有 UE 连接」
   * 当成「这不是个能干活的工程」。会话工程是用户自己挑的文件夹，仅此而已。
   *
   * **不许在这里列举引擎名**。列了 Godot 就得列 Unity、列 Blender，列到哪一版
   * 算全？而且列举本身就是在替用户假设他在干什么。正确的说法是否定式的：
   * 这些字段**不报告**文件夹里装着什么 —— 一句话覆盖所有没列到的情况。
   */
  it('说清会话归属、登记路径、连接状态是三件事，谁都不证明工程类型', () => {
    expect(rules).toContain('Each field means exactly one thing')
    expect(rules).toContain('that is the whole of what they report')
  })

  /**
   * 「登记路径不证明目录还在」这句话**不该出现在规则里** —— 它现在写在键名
   * `path_on_record` 上，由 `formatRuntimeEnvelope` 印出来。
   *
   * 这条判据比字面断言重要：每一条写成「X 不等于 Y」的规则，都是一张收据，
   * 证明我们把一个测量 X 的字段命名成了 Y。收据能报销（在提示词里解释），
   * 但更该做的是别再开这张单。谁要是把这句解释加回规则里，多半是因为又把
   * 键名改回了 `path`。
   */
  it('登记路径的限定词长在键名上，不靠规则里的散文兜底', () => {
    expect(
      formatRuntimeEnvelope({ ...base, sessionProject: { name: 'A', pathOnRecord: '/a' } })
    ).toContain('path_on_record /a')
    expect(rules).not.toContain('not proof that the folder is still there')
  })

  // 列举等于替用户假设他在用什么。开了这个头就没有收敛的版本
  it('不点名任何具体引擎', () => {
    for (const name of ['Godot', 'Unity', 'Blender', 'Unigine', 'CryEngine']) {
      expect(rules).not.toContain(name)
    }
  })

  /**
   * 规则一律写成**该做什么**，而不是不许做什么。
   *
   * 官方建议原文：「Tell Claude what to do instead of what not to do」，给的例子是
   * 「Do not use markdown」要改写成「Your response should be composed of smoothly
   * flowing prose paragraphs」。道理是否定句留下的空白是「那我该干嘛」——
   * 而这一段规则的每一条都有明确的正确做法，没有一条是只能靠禁止表达的。
   *
   * 这里钉 0 而不是「少一点」：一旦允许有例外，下一条真机故障还是会以
   * 「别再 X 了」的形态被加进来，而那正是这一段过去长成判例法的方式。
   * 确实需要表达「不成立」时，说清**成立的是什么**（「A 只说明 B」「只有 C
   * 才能推出 D」），信息量比一句禁止更大。
   */
  it('规则里没有硬性禁止句，一律说该做什么', () => {
    const negatives = rules.match(/\b(do not|never|cannot)\b/gi) ?? []

    expect(negatives).toEqual([])
  })

  it('说清「最后一个信封压过更早的」', () => {
    expect(rules).toContain('The last `<runtime-status>` outranks every earlier one')
  })

  /**
   * 比证据要比**同一个对象、同一件事**。
   *
   * 两个方向都会错：新信封里少了某个字段就当此前的信息作废（其实只是这轮没重新
   * 观测），以及拿别的工程的观测去判断当前工程。
   */
  it('说清「缺字段不等于被推翻」和「别的工程的观测不算数」', () => {
    expect(rules).toContain('still stands as recorded')
    expect(rules).toContain('speaks only for the project it came from')
  })

  /**
   * 未知 ≠ 否定，失败只支持它自己说的那句话。
   *
   * 这条是这次改动的重点：原文从「工具失败」直接推到「编辑器没了」，
   * 而超时、权限不足、参数错误都得不出这个结论 —— 照着它答，用户会被告知
   * 一件根本没发生的事，而真正的失败原因一个字都没提。
   */
  it('说清未知不是否定，且只有连接类错误才能推出「编辑器没了」', () => {
    expect(rules).toContain('Read an absent field as "unknown"')
    expect(rules).toContain('A timeout means the operation was not confirmed')
    expect(rules).toContain('client not found or disconnected')
  })

  /**
   * 该不该验证，由任务定，不由用户有没有开口定。
   *
   * 反面教材就在这套规则自己的历史里：为了修「问路径却去扫盘」，这里一度写过
   * 「只有用户明确询问文件内容时才能检查文件」。那句话让一次验收过了，也顺手把
   * 「帮我修这个工程的代码」变成了要先请示才能读文件。
   */
  it('说清按任务需要决定验证，既不许无谓扫盘也不许拒绝检查', () => {
    expect(rules).toContain('Verify whenever the task needs it')
    expect(rules).toContain('permission to inspect is already yours')
    expect(rules).toContain('search as widely as the clues support')
    // 「先从已知对象开始，按证据逐步扩大」——不是「不许找」
    expect(rules).toContain('widen it only as far as the evidence justifies')
  })

  // 与任务无关的连接/安装/切换建议是纯噪声，真机上它还会把用户引向不存在的操作
  it('要求只在影响答案或下一步时才解释限制', () => {
    expect(rules).toContain('Explain a limitation when it changes')
    expect(rules).toContain('let the answer end there')
  })

  /**
   * 信封是**发消息那一刻**的快照，而环境块现在每一步都会重算。
   *
   * 这条断言原先反过来写：「两者永远一致」。工具清单能中途换之后那句话就是假的 ——
   * 起手没连引擎、模型自己把工程打开之后，环境块写着「已连接」、手里也真有
   * `ue.*`，而最后那个信封仍然停在 `engine_tools: unavailable`。规则却告诉模型
   * 信封最权威、不可能矛盾，于是它可以一边攥着能用的引擎工具，一边回一句
   * 「这条会话里引擎用不了」——正是这套机制要消灭的那个场面，由提示词亲手重造。
   */
  it('说清环境块比信封新，矛盾时按新的那份算', () => {
    expect(rules).toContain('when it and the envelope disagree, go by the block')
    expect(rules).not.toContain('always agree')
  })

  /**
   * 但**真失败的工具调用压过它俩**。
   *
   * 这句话不能少：子 agent 的环境块和工具清单在派出去那一刻就冻住了，整段不刷新。
   * 只说「环境块赢」「手里有工具就说明能用」的话，父 agent 派活之后用户把编辑器
   * 关了，子 agent 每条命令都回「客户端不存在或已断开」，而它照着提示词把这些
   * 当成暂时性抖动，重试几轮再向父 agent 报一句「连接正常」。
   */
  it('明令真失败的工具调用压过环境块和工具清单', () => {
    expect(rules).toContain('a tool call that actually failed outranks both')
    expect(rules).toContain('sub-agent')
  })

  // 真机故障的直接落点：模型让历史盖过了当前状态
  it('明令历史不得覆盖最后一个信封，并点破那样等于对用户说假话', () => {
    expect(rules).toContain('says what was true then, not what is true now')
    expect(rules).toContain('telling the user something false')
  })

  it('说清健康检查结果按作用域算数', () => {
    expect(rules).toContain(HEALTH_SCOPE_FIELD)
    expect(rules).toContain('legacy historical observation')
  })

  /**
   * 故障的另一半：引擎明明连着，模型却退回去扫磁盘。
   * 磁盘上的 `.uasset` 文件名说不出那个资产是什么，所以这条必须写死。
   */
  it('禁止拿磁盘工具冒充内容浏览器', () => {
    expect(rules).toContain('list_local_dir')
    expect(rules).toContain('carries only the name')
  })

  /**
   * 这条断言原先反过来写：「工具清单一轮之内定死，中途连上也不补发」。
   *
   * 那句话曾经是真的，但它带来的行为是错的 —— 模型照着它对用户说「我这轮拿不到
   * 引擎工具了，请你再发一条消息」。真机上更难看的一幕是模型自己把新工程建好、
   * 打开、连上了，然后请用户去界面上把当前工程切过去。用户什么信息都不用补，
   * 那一步纯粹是盒子偷懒。
   *
   * 现在工具清单每步都重算（`createAgent.ts` 的 `prepareNextTurnWithContext`），
   * 所以规则也要跟着改口。**两处必须同时改**：只改代码不改这段话，模型仍然会
   * 照着旧话去请用户帮忙。
   */
  it('说清工具清单中途会补发，不许请用户再发一条消息', () => {
    expect(rules).toContain('re-checked before every step')
    expect(rules).toContain('defaults to waitSeconds=0')
    expect(rules).toContain('connected=false is not a launch failure')
    expect(rules).toContain('verify readiness and retarget this turn')
    expect(rules).toContain('connected=true and switched_target=true')
  })

  // 用户明明连着引擎，这时候劝他装插件是答非所问
  it('连着但不是本会话的工程时，禁止劝人装插件', () => {
    expect(rules).toContain('treat the plugin and the connection as working')
  })

  // 这一段是上面那次「编时间」故障的另一半：光把时刻印对还不够，
  // 得明说这就是回答时间问题的地方，否则模型仍会去翻自己的记忆
  it('明说时间问题从 now 那一行取，而不是从记忆里取', () => {
    expect(rules).toContain('where questions about the time are answered from')
  })
})

describe('formatLocalNow', () => {
  /** 断言里按本地时区现算期望值 —— 写死 UTC+08:00 的话，CI 换个时区就红 */
  const expectedOffset = (now: Date): string => {
    const minutes = -now.getTimezoneOffset()
    const absolute = Math.abs(minutes)
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `UTC${minutes < 0 ? '-' : '+'}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  }

  it('印出本地日期、时刻、时区偏移和星期', () => {
    const now = new Date(2026, 8, 22, 1, 54, 3)

    expect(formatLocalNow(now)).toBe(`2026-09-22 01:54:03 ${expectedOffset(now)} (Tuesday)`)
  })

  it('补零补到两位，不留 1:5:3 这种读不准的串', () => {
    expect(formatLocalNow(new Date(2026, 0, 2, 3, 4, 5))).toContain('2026-01-02 03:04:05')
  })

  /**
   * 符号最容易写反：`getTimezoneOffset()` 对东八区返回 **-480**，
   * 而人写出来的是 UTC**+**08:00。倒错号的话模型会把时间往反方向推十六小时，
   * 而它不会察觉 —— 这种错没有任何症状，只有结论是错的。
   */
  it('时区偏移的符号跟着 UTC 写法，不跟着 getTimezoneOffset', () => {
    const now = new Date(2026, 8, 22, 1, 54, 3)
    const minutes = -now.getTimezoneOffset()

    // 正好在 UTC 上（偏移 0）时两种符号都算对，这条不适用
    if (minutes !== 0) {
      expect(formatLocalNow(now).includes('UTC+')).toBe(minutes > 0)
    }
  })

  /** 不走 toLocaleString 的理由：星期必须是英文，跟着系统区域走会印出「星期二」 */
  it('星期是英文，不跟系统区域设置走', () => {
    expect(formatLocalNow(new Date(2026, 8, 20, 12, 0, 0))).toContain('(Sunday)')
  })
})
