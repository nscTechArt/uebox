import { beforeEach, describe, expect, it } from 'vitest'

import type { AgentQuestion } from '../../../shared/agentQuestion'
import { APPROVE_TASK } from '../../../shared/voiceFrontDesk'

import type { ToolRisk } from '../../agent-v3/tools/defineTool'

import { PROGRESS_THROTTLE_MS, type VoiceFloor } from './narrator'
import {
  createVoiceTaskBus,
  describeQuestion,
  describeTask,
  estimateSpeechMs,
  speakTask,
  type VoiceTask,
  type VoiceTaskBus
} from './taskBus'

const SESSION = 'session-1'

/** 真表在 `listToolRisks()`，这里只列用得到的几个读工具，其余按写算 */
const SAFE_TOOLS = new Set([
  'blueprint_describe',
  'blueprint_get_graph',
  'material_describe',
  'list_local_dir',
  'find_local_files'
])
const toolRisk = (toolName: string): ToolRisk => (SAFE_TOOLS.has(toolName) ? 'safe' : 'mutating')

const QUESTION: AgentQuestion = {
  header: '配色',
  question: '要冷色还是暖色',
  multiSelect: false,
  options: [
    { label: '冷色', description: '偏蓝' },
    { label: '暖色', description: '偏橙' }
  ]
}

describe('describeTask', () => {
  it('跑着的、跑完的、没有的，各说各的话', () => {
    expect(describeTask(undefined)).toBe('现在没有任务在跑。')
  })

  it('派到别的对话时把对话名念出来 —— 不然用户不知道动的是哪个项目', () => {
    const text = describeTask({
      id: 't1',
      agentSessionId: SESSION,
      sessionLabel: '副本关卡',
      instruction: '编译蓝图',
      status: 'done',
      startedAt: 0,
      stage: '',
      outcome: '编译通过'
    })

    expect(text).toContain('副本关卡')
    expect(text).toContain('已完成：编译通过')
  })

  it('太长的结果截断 —— Agent 的回答可能有好几屏，全念完没人受得了', () => {
    const text = describeTask({
      id: 't1',
      agentSessionId: SESSION,
      sessionLabel: '',
      instruction: '整理材质',
      status: 'done',
      startedAt: 0,
      stage: '',
      outcome: '好'.repeat(500)
    })

    expect(text).toContain('……')
    expect(text.length).toBeLessThan(300)
  })
})

describe('speakTask', () => {
  /*
   * 豆包那条链路会把这句话**逐字念出来**（3.0 没有 response.create，
   * 主动出声只能走 TTS 直合成），所以它必须是人话，不能是日志。
   */
  function task(patch: Partial<VoiceTask>): VoiceTask {
    return {
      id: 't1',
      agentSessionId: SESSION,
      sessionLabel: '',
      instruction: '查场景',
      status: 'done',
      startedAt: 0,
      stage: '',
      outcome: '',
      ...patch
    }
  }

  it('跑完就直接念 Agent 的回答，不念任务号', () => {
    const text = speakTask(task({ status: 'done', outcome: '一共 476 个 Actor。' }))

    expect(text).toBe('一共 476 个 Actor。')
    expect(text).not.toContain('t1')
  })

  it('失败要说得明白 —— 含糊过去用户会以为事情办成了', () => {
    expect(speakTask(task({ status: 'failed', outcome: '连不上编辑器' }))).toBe(
      '没做成：连不上编辑器'
    )
  })

  /*
   * 几个灶同时跑的时候不报灶名就是灾难：用户听见一句「做完了」，完全不知道是
   * 刚才交代的哪一件。只有一个灶的时候报灶名反过来是废话。
   */
  it('不止一个灶在跑时把灶名念出来', () => {
    const done = task({ sessionLabel: '副本关卡', status: 'done', outcome: '编译通过' })

    expect(speakTask(done, { withLane: true })).toBe('副本关卡那边，编译通过')
    expect(speakTask(done)).toBe('编译通过')
  })

  it('跑完了但 Agent 一个字没说也要有句话，不能念空', () => {
    expect(speakTask(task({ status: 'done', outcome: '' }))).toBe('做完了。')
  })
})

describe('describeQuestion', () => {
  it('选项也要念出来，不然用户不知道有哪些出路', () => {
    expect(describeQuestion([QUESTION])).toBe('要冷色还是暖色（可选：冷色、暖色）')
  })
})

describe('createVoiceTaskBus', () => {
  /** 播出去的两份：`speech` 用户听见，`context` 进模型上下文 */
  let announced: { speech: string; context: string; kind?: 'question' | 'approval' }[]
  /** 用户真正听到的那些话 */
  let spoken: string[]
  /** 队列排到、被推出去开跑的那些 */
  let started: string[]
  let floor: VoiceFloor
  let clock: number
  let bus: VoiceTaskBus

  beforeEach(() => {
    announced = []
    spoken = []
    started = []
    floor = { active: true, userSpeaking: false, assistantSpeaking: false }
    clock = 1_000_000
    bus = createVoiceTaskBus({
      announce: (notice) => {
        announced.push(notice)
        spoken.push(notice.speech)
      },
      startRun: (task) => {
        started.push(task.instruction)
        return true
      },
      floor: () => floor,
      toolRisk,
      now: () => clock
    })
  })

  function register(instruction = '把灯调暗', sessionId = SESSION): string {
    const result = bus.register({ agentSessionId: sessionId, instruction })
    if (result.action !== 'start') throw new Error(`本以为会直接开跑，实际是 ${result.action}`)
    return result.task.id
  }

  it('用 Agent 自己说的话当结果，而不是一句界面文案', () => {
    const id = register()

    bus.onSignal({ type: 'started', sessionId: SESSION })
    bus.onSignal({ type: 'text', sessionId: SESSION, text: '灯亮度' })
    bus.onSignal({ type: 'text', sessionId: SESSION, text: '已经减半了。' })
    bus.onSignal({ type: 'done', sessionId: SESSION })

    expect(bus.find(id)?.status).toBe('done')
    expect(spoken.at(-1)).toContain('灯亮度已经减半了。')
  })

  /*
   * Codex 那套是两层：后台模型先产出一句适合口头说的结果，再交给语音端。
   * 我们让 Agent 用 voice_report 自己报：中途按阶段报、做完报一次 ——
   * 屏幕上那段 markdown 念出来全是路径和列表。
   */
  describe('Agent 自己开口汇报（voice_report）', () => {
    it('中途进度念出来；做完那句念过之后收尾不再补一句', () => {
      const id = register()

      bus.onSignal({
        type: 'report',
        sessionId: SESSION,
        status: 'running',
        message: '找到工程了，正在打开。'
      })
      expect(spoken).toEqual(['找到工程了，正在打开。'])

      clock += estimateSpeechMs(spoken[0]) + PROGRESS_THROTTLE_MS
      bus.onSignal({ type: 'report', sessionId: SESSION, status: 'done', message: '工程打开了。' })
      expect(spoken.at(-1)).toBe('工程打开了。')

      bus.onSignal({ type: 'done', sessionId: SESSION })
      expect(spoken).toHaveLength(2)
      expect(bus.find(id)?.status).toBe('done')
      // check_task 问起来，答的也是它自己那句
      expect(describeTask(bus.find(id))).toContain('工程打开了。')
    })

    /*
     * 真机 2026-09-16：用户听见「三十个测试分组全部删掉了」，道了别，
     * 再见也说完了，然后音箱里又来一句「找到了那三十个，现在开始一个个删」——
     * 听起来像同一件事又被做了一遍。那是一条压在节流窗口里的旧进度：
     * 结果不受节流，越过它先念了，它却还留在队里等着轮到自己。
     */
    it('活做完了，还压在队里的进度就作废，不能在结果之后再冒出来', () => {
      register('把那三十个测试分组删掉')

      bus.onSignal({
        type: 'report',
        sessionId: SESSION,
        status: 'running',
        message: '正在删掉那三十个测试分组。'
      })
      expect(spoken).toEqual(['正在删掉那三十个测试分组。'])

      // 上一句念完了，但还在八秒节流窗口里 —— 这条进度只能压着
      clock += estimateSpeechMs(spoken[0]) + 100
      bus.onSignal({
        type: 'report',
        sessionId: SESSION,
        status: 'running',
        message: '找到了那三十个，现在开始一个个删。'
      })
      expect(spoken).toHaveLength(1)

      // 结果是高优先级，不受节流，越过压着那条先念
      bus.onSignal({
        type: 'report',
        sessionId: SESSION,
        status: 'done',
        message: '三十个测试分组全删掉了。'
      })
      expect(spoken.at(-1)).toBe('三十个测试分组全删掉了。')
      bus.onSignal({ type: 'done', sessionId: SESSION })

      // 节流窗口过去了，那条旧进度也不许再冒出来
      clock += PROGRESS_THROTTLE_MS * 10
      bus.flush()
      expect(spoken).toEqual(['正在删掉那三十个测试分组。', '三十个测试分组全删掉了。'])
    })

    it('卡住了是用户在等的答案，模型在说也排在最前、说完就念', () => {
      register()
      floor = { active: true, userSpeaking: false, assistantSpeaking: true }

      bus.onSignal({
        type: 'report',
        sessionId: SESSION,
        status: 'blocked',
        message: '没找到 moba 工程，告诉我它在哪个文件夹。'
      })
      expect(spoken).toEqual([])

      floor = { active: true, userSpeaking: false, assistantSpeaking: false }
      bus.flush()
      expect(spoken.at(-1)).toBe('没找到 moba 工程，告诉我它在哪个文件夹。')
    })

    it('Agent 开口之后，机械的「在改蓝图」不再插嘴', () => {
      register()
      bus.onSignal({
        type: 'report',
        sessionId: SESSION,
        status: 'running',
        message: '开始改蓝图。'
      })
      clock += estimateSpeechMs('开始改蓝图。') + PROGRESS_THROTTLE_MS

      bus.onSignal({ type: 'tool', sessionId: SESSION, toolName: 'blueprint_apply_graph' })
      bus.flush()

      expect(spoken).toEqual(['开始改蓝图。'])
    })

    it('没报过 done 的，收尾照旧念正文最后一段', () => {
      register()
      bus.onSignal({ type: 'report', sessionId: SESSION, status: 'running', message: '在找工程。' })
      clock += estimateSpeechMs('在找工程。') + PROGRESS_THROTTLE_MS
      bus.onSignal({ type: 'text', sessionId: SESSION, text: '工程已经打开。' })

      bus.onSignal({ type: 'done', sessionId: SESSION })

      expect(spoken.at(-1)).toContain('工程已经打开。')
    })
  })

  /*
   * 真机上 Agent 没报结果，收尾把屏幕上那段 markdown 逐字念了：星号、路径、PID 全念，
   * 还在「SampleP」处硬截。先按规则收拾，再让模型压一句。
   */
  describe('Agent 没报结果时收尾念什么', () => {
    const MARKDOWN =
      '截图这条路径走不通：\n\n**当前状态**\n\n- **UALinkDev55 编辑器在跑**（`I:\\UnrealAgent\\UALinkDev55`），**没有连回盒子**。'

    it('模型压出一句就念那句', async () => {
      bus = createVoiceTaskBus({
        announce: (notice) => spoken.push(notice.speech),
        startRun: () => true,
        floor: () => floor,
        toolRisk,
        summarize: async () => '截图没拍成，编辑器开着但没连回盒子。',
        now: () => clock
      })
      register()
      bus.onSignal({ type: 'text', sessionId: SESSION, text: MARKDOWN })

      bus.onSignal({ type: 'done', sessionId: SESSION })
      await Promise.resolve()
      await Promise.resolve()

      expect(spoken).toEqual(['截图没拍成，编辑器开着但没连回盒子。'])
    })

    it('模型压不出来（没配、超时、抛错）就念规则收拾过的那句，不念星号和路径', async () => {
      bus = createVoiceTaskBus({
        announce: (notice) => spoken.push(notice.speech),
        startRun: () => true,
        floor: () => floor,
        toolRisk,
        summarize: async () => {
          throw new Error('还没配置「对话」模型')
        },
        now: () => clock
      })
      register()
      bus.onSignal({ type: 'text', sessionId: SESSION, text: MARKDOWN })

      bus.onSignal({ type: 'done', sessionId: SESSION })
      await Promise.resolve()
      await Promise.resolve()

      expect(spoken).toHaveLength(1)
      expect(spoken[0]).not.toMatch(/[*`]/)
      expect(spoken[0]).not.toContain('I:\\')
      expect(spoken[0]).toContain('UALinkDev55 编辑器在跑')
    })

    it('没给模型这条路也照样念规则那句', () => {
      register()
      bus.onSignal({ type: 'text', sessionId: SESSION, text: MARKDOWN })

      bus.onSignal({ type: 'done', sessionId: SESSION })

      expect(spoken).toHaveLength(1)
      expect(spoken[0]).not.toMatch(/[*`]/)
    })
  })

  // 真机上念了半分钟的「我先找一下…」「这两个地方都没有…」，最后的答案反而被截掉
  it('结果只念最后那段回答，不把中间的碎碎念串起来', () => {
    register()

    bus.onSignal({ type: 'text', sessionId: SESSION, text: '我先找一下盒子里登记的工程。' })
    bus.onSignal({ type: 'tool', sessionId: SESSION, toolName: 'list_local_dir' })
    bus.onSignal({ type: 'text', sessionId: SESSION, text: '这两个地方都没有，再搜别处。' })
    bus.onSignal({ type: 'tool', sessionId: SESSION, toolName: 'find_local_files' })
    bus.onSignal({ type: 'text', sessionId: SESSION, text: '没找到 moba，请告诉我路径。' })
    bus.onSignal({ type: 'done', sessionId: SESSION })

    expect(spoken.at(-1)).toContain('没找到 moba')
    expect(spoken.at(-1)).not.toContain('我先找一下')
    expect(spoken.at(-1)).not.toContain('再搜别处')
  })

  /*
   * 一条 agent 会话同时只能有一件活（`agent-v3:execute` 本来就拒并发）。
   * 但直接回绝「等会儿再说」听着像它没听懂 —— 所以排队。
   */
  it('会话忙着时默认排队，不回绝', () => {
    register('第一件')

    const second = bus.register({ agentSessionId: SESSION, instruction: '第二件' })

    expect(second.action).toBe('queued')
    if (second.action === 'queued') expect(second.position).toBe(1)
    // 排着的那件还没开跑
    expect(started).toEqual([])
  })

  /*
   * `done` 是 agent 事件流里的最后一条，但它发出来时主进程还没把会话从
   * activeAgents 摘掉 —— 那会儿派下一件，`agent-v3:execute` 回的是「正在执行中」，
   * 排队的那件就莫名其妙地失败了。要等 `released`。
   */
  it('前面那件做完，要等会话真的空出来（released）才推下一件', () => {
    register('第一件')
    bus.register({ agentSessionId: SESSION, instruction: '第二件' })

    bus.onSignal({ type: 'done', sessionId: SESSION })
    expect(started).toEqual([])

    bus.onSignal({ type: 'released', sessionId: SESSION })
    expect(started).toEqual(['第二件'])
    expect(bus.snapshot().find((t) => t.instruction === '第二件')?.status).toBe('running')
  })

  it('一次只推一件 —— 会话同时只能有一件活', () => {
    register('第一件')
    bus.register({ agentSessionId: SESSION, instruction: '第二件' })
    bus.register({ agentSessionId: SESSION, instruction: '第三件' })

    bus.onSignal({ type: 'done', sessionId: SESSION })
    bus.onSignal({ type: 'released', sessionId: SESSION })

    expect(started).toEqual(['第二件'])
  })

  it('released 时还挂着 running 的那件要兜底标掉，否则会话永远腾不出来', () => {
    // 异常从 prompt() 抛穿、pi 没来得及发终态消息 —— 只有 finally 里的 released 会来
    const id = register('第一件')
    bus.register({ agentSessionId: SESSION, instruction: '第二件' })

    bus.onSignal({ type: 'released', sessionId: SESSION })

    expect(bus.find(id)?.status).toBe('failed')
    expect(bus.register({ agentSessionId: SESSION, instruction: '重来一次' }).action).toBe('held')
    expect(bus.resumeTask(id)?.id).toBe(id)
    // 但队里那件**不自动**接着跑：前一件是砸的，见「前一件砸了之后」那组
    expect(started).toEqual([])
  })

  /*
   * 语音关着的时候没人收 run-task。不能让它顶着 running 占住会话 ——
   * 那样下次开语音派活会排在一件永远不会开始的活后面。
   */
  it('推不出去就留在队里，语音重新开了 resume 再推', () => {
    let delivered = false
    bus = createVoiceTaskBus({
      announce: () => {},
      startRun: (task) => {
        if (!delivered) return false
        started.push(task.instruction)
        return true
      },
      floor: () => floor,
      toolRisk,
      now: () => clock
    })
    register('第一件')
    const second = bus.register({ agentSessionId: SESSION, instruction: '第二件' })
    const secondId = second.action === 'queued' ? second.task.id : ''

    bus.onSignal({ type: 'done', sessionId: SESSION })
    bus.onSignal({ type: 'released', sessionId: SESSION })
    expect(started).toEqual([])
    expect(bus.find(secondId)?.status).toBe('queued')
    // 会话没被那件占着：现在派新活直接开跑，不会排在它后面
    expect(bus.register({ agentSessionId: 'session-b', instruction: '别处' }).action).toBe('start')

    delivered = true
    bus.resume()
    expect(started).toEqual(['第二件'])
    expect(bus.find(secondId)?.status).toBe('running')
  })

  /*
   * 启动失败时**没有 `released` 会来**，所以这条路自己要把会话腾出来 ——
   * 不腾的话那件活在任务表里永远占着位子，后面派什么都排在它后面。
   *
   * 腾出来 ≠ 自动推下一件：起不来多半是会话还占着或者环境有问题，
   * 接着推只会连着失败一串（和「前一件砸了」是同一条道理）。
   */
  it('启动失败要把会话腾出来，但不自动推下一件', () => {
    const id = register('第一件')
    const queued = bus.register({ agentSessionId: SESSION, instruction: '第二件' })

    bus.abandon(id, '会话正在执行中')

    expect(started).toEqual([])
    expect(bus.find(queued.task.id)?.status).toBe('queued')
    expect(bus.register({ agentSessionId: SESSION, instruction: '重来一次' }).action).toBe('held')
    expect(bus.resumeTask(id)?.id).toBe(id)
  })

  it('渲染层晚到的失败回调不会把队里那件重复处置', () => {
    // 主进程先报 error（旁路信号），渲染层的失败回调随后才到 —— 这是常态
    const id = register('第一件')
    const queued = bus.register({ agentSessionId: SESSION, instruction: '第二件' })

    bus.onSignal({ type: 'error', sessionId: SESSION, message: '连不上' })
    bus.abandon(id, '连不上')
    bus.onSignal({ type: 'released', sessionId: SESSION })

    // 前一件砸了，队里那件挂着不动；三条路径都到这儿，状态只有一个
    expect(started).toEqual([])
    expect(bus.find(queued.task.id)?.status).toBe('queued')
    expect(bus.find(id)?.status).toBe('failed')
  })

  /*
   * 用户叫停多半是因为事情不对劲。停下的那一刻紧接着自动开跑下一件，
   * 他会以为「停下」没生效 —— 撤错了大不了再说一遍，开错了改掉的东西不会自己退回。
   */
  it('用户叫停正在跑的，队里还没开始的也一起撤，并且说出来', () => {
    register('第一件')
    const second = bus.register({ agentSessionId: SESSION, instruction: '第二件' })
    const secondId = second.action === 'queued' ? second.task.id : ''

    bus.onSignal({ type: 'stopped', sessionId: SESSION })
    bus.onSignal({ type: 'released', sessionId: SESSION })

    expect(bus.find(secondId)?.status).toBe('stopped')
    expect(started).toEqual([])
    expect(spoken.at(-1)).toContain('后面排着的 1 件也一起撤了')
  })

  it('不给任务号时先挑正在跑的，不是最近登记的那件', () => {
    // 否则「停下」撤掉的是排队的第二件，正在跑的第一件照跑不误
    const first = register('第一件')
    bus.register({ agentSessionId: SESSION, instruction: '第二件' })

    expect(bus.find()?.id).toBe(first)
  })

  /*
   * 插队是对**正在跑的这件**的修正，不新开一件活 —— 单独记一件的话，
   * 用户问「刚才那个好了没」会被引到一件根本没有独立结果的活上。
   */
  it('明确要插队时走 steer，不新开一件活', () => {
    const id = register('第一件')

    const result = bus.register({
      agentSessionId: SESSION,
      instruction: '等等，只改那盏主灯',
      when: 'now'
    })

    expect(result.action).toBe('steer')
    if (result.action === 'steer') expect(result.task.id).toBe(id)
    expect(bus.snapshot()).toHaveLength(1)
  })

  it('不同会话可以同时跑 —— 这正是跨会话派发的意义', () => {
    register('这边', 'session-a')

    expect(bus.register({ agentSessionId: 'session-b', instruction: '那边' }).action).toBe('start')
  })

  /*
   * 一通电话开几个灶（每个灶一条 agent 会话）之后，几件事同时跑成了常态。
   * 下面这几条都是「只有一件在跑时恰好总是对的、几件同时跑就会出错」的地方。
   */
  describe('几个灶同时跑', () => {
    it('灶况带上每个灶在干什么和排了几件 —— 模型挑下一个灶全靠它', () => {
      register('把主灯调暗', 'session-灯光')
      bus.register({
        agentSessionId: 'session-灯光',
        instruction: '再调色温',
        sessionLabel: '灯光'
      })
      register('整理内容浏览器', 'session-内容')

      const text = bus.describeWorkers()

      expect(text).toContain('2 个灶')
      expect(text).toContain('把主灯调暗')
      expect(text).toContain('整理内容浏览器')
      expect(text).toContain('后面还排着 1 件')
    })

    it('一个灶都没开时说清楚是空的，别让模型以为查不到', () => {
      expect(bus.describeWorkers()).toBe('现在所有灶都空着。')
    })

    /*
     * 这条是多灶逼出来的**正确性**问题，不是措辞问题。
     *
     * 不给任务号时原先退回「最近登记的那件」。一个灶的时候它恰好总是在等答案的
     * 那件；几个灶同时跑的时候，最近登记的那件很可能根本没在问人 —— 答案于是被
     * 送给一个没在等的 Agent，真正卡着的那个继续卡着。不报错，表现是
     * 「我明明答了，它还在问」。
     */
    it('不给任务号时，答案交给真正在等的那件，不是最近登记的那件', () => {
      const asking = register('改蓝图', 'session-蓝图')
      bus.onSignal({
        type: 'question',
        sessionId: 'session-蓝图',
        toolCallId: 'call-9',
        questions: [QUESTION]
      })
      // 之后又派了一件，它没在问任何人
      register('整理内容浏览器', 'session-内容')

      expect(bus.pendingQuestion()?.task.id).toBe(asking)
      expect(bus.pendingQuestion()?.toolCallId).toBe('call-9')
    })

    it('两件都在等人答时，交给刚念出去的那一件', () => {
      register('改蓝图', 'session-蓝图')
      const later = register('整理内容', 'session-内容')
      bus.onSignal({
        type: 'question',
        sessionId: 'session-蓝图',
        toolCallId: 'call-蓝图',
        questions: [QUESTION]
      })
      // 上一条还在念，这一条压在队里；等它念出去了才该轮到它收答案
      clock += estimateSpeechMs(spoken[0]) + PROGRESS_THROTTLE_MS
      bus.onSignal({
        type: 'question',
        sessionId: 'session-内容',
        toolCallId: 'call-内容',
        questions: [QUESTION]
      })

      expect(bus.pendingQuestion()?.task.id).toBe(later)
      expect(bus.pendingQuestion()?.toolCallId).toBe('call-内容')
    })

    it('一件都没在等的时候照实回 undefined，不硬塞一件出来', () => {
      register()

      expect(bus.pendingQuestion()).toBeUndefined()
      expect(bus.pendingApproval()).toBeUndefined()
    })

    // 用户说「停下」而不止一件在跑时，猜错就是停掉了他没想停的那件
    it('正在跑的那几件报得出来，好让调用方决定要不要先问清楚', () => {
      register('这边', 'session-a')
      register('那边', 'session-b')
      bus.onSignal({ type: 'done', sessionId: 'session-a' })

      expect(bus.running().map((task) => task.instruction)).toEqual(['那边'])
    })
  })

  /*
   * 真机（2026-09-03）：搬资产那件把编辑器搞崩了，紧接着排在后面的「做个材质」
   * 自己开跑了 —— 而那会儿编辑器已经没了。用户听到「刚才那件失败了」，然后盒子
   * 若无其事地开始做下一件。
   *
   * 和 §6.6「用户叫停时把队里的一起撤」是同一条道理，当时只写进了 stopped 那一支。
   */
  describe('前一件砸了之后，队里的不许自动接着跑', () => {
    function queueBehind(instruction: string): string {
      const result = bus.register({ agentSessionId: SESSION, instruction })
      if (result.action !== 'queued') throw new Error(`本以为会排队，实际是 ${result.action}`)
      return result.task.id
    }

    it('失败之后队里的挂起，问用户还要不要做', () => {
      register('搬资产')
      const queued = queueBehind('做个材质')

      bus.onSignal({ type: 'error', sessionId: SESSION, message: '编辑器崩了' })
      bus.onSignal({ type: 'released', sessionId: SESSION })

      expect(started).toEqual([])
      expect(bus.find(queued)?.status).toBe('queued')
      // 「没做成」先念，问句压在后面 —— 一次只放一条，等它念完
      expect(spoken.at(-1)).toContain('没做成')
      clock += estimateSpeechMs(spoken[spoken.length - 1]) + PROGRESS_THROTTLE_MS
      bus.flush()
      expect(spoken.at(-1)).toContain('还要接着做吗')
    })

    it('重连保留挂起；用户明确恢复原任务后只执行一次', () => {
      register('搬资产')
      const queued = queueBehind('做个材质')
      bus.onSignal({ type: 'error', sessionId: SESSION, message: '编辑器崩了' })
      bus.onSignal({ type: 'released', sessionId: SESSION })

      bus.resume()
      expect(started).toEqual([])
      expect(bus.register({ agentSessionId: SESSION, instruction: '做个材质' }).action).toBe('held')
      expect(bus.resumeTask(queued)?.id).toBe(queued)
      expect(bus.resumeTask(queued)).toBeUndefined()
      bus.onSignal({ type: 'done', sessionId: SESSION })
      bus.onSignal({ type: 'released', sessionId: SESSION })
      bus.resume()
      expect(started).toEqual([])
      expect(bus.find(queued)?.status).toBe('done')
      expect(bus.snapshot()).toHaveLength(2)
    })

    it('业务报告被阻塞时不能当成成功继续后续任务', () => {
      const first = register('准备输入')
      const queued = queueBehind('使用输入修改材质')
      bus.onSignal({ type: 'report', sessionId: SESSION, status: 'blocked', message: '缺少源文件' })
      bus.onSignal({ type: 'done', sessionId: SESSION })
      bus.onSignal({ type: 'released', sessionId: SESSION })
      bus.resume()

      expect(bus.find(first)?.status).toBe('blocked')
      expect(bus.find(queued)?.status).toBe('queued')
      expect(started).toEqual([])
    })

    // 正常做完当然要接着跑下一件，别把排队功能一起关掉了
    it('前一件是做完的，下一件照旧自动开跑', () => {
      register('搬资产')
      queueBehind('做个材质')

      bus.onSignal({ type: 'done', sessionId: SESSION })
      bus.onSignal({ type: 'released', sessionId: SESSION })

      expect(started).toEqual(['做个材质'])
    })

    // 用户自己叫停的那条路本来就把队里的撤了，别再多问一句
    it('用户叫停时照旧一起撤，不再问「还要接着做吗」', () => {
      register('搬资产')
      const queued = queueBehind('做个材质')

      bus.onSignal({ type: 'stopped', sessionId: SESSION })
      bus.onSignal({ type: 'released', sessionId: SESSION })

      expect(started).toEqual([])
      expect(bus.find(queued)?.status).toBe('stopped')
      expect(spoken.join('')).not.toContain('还要接着做吗')
    })
  })

  it('失败后必须等退出再恢复，上一次迟到的失败不会打掉恢复后的运行', () => {
    const id = register('重试目标')
    bus.onSignal({ type: 'error', sessionId: SESSION, message: '断网' })
    expect(bus.resumeTask(id)).toBeUndefined()
    bus.onSignal({ type: 'released', sessionId: SESSION })
    expect(bus.resumeTask(id)?.attempt).toBe(2)
    bus.abandon(id, '上一次的迟到回调', 1)
    expect(bus.find(id)?.status).toBe('running')
    bus.abandon(id, '本次启动失败', 2)
    expect(bus.find(id)?.status).toBe('failed')
  })

  it('明确恢复一件不会放行其他仍挂起的任务，查询如实显示挂起', () => {
    register('第一件')
    const a = bus.register({ agentSessionId: SESSION, instruction: 'A' }).task.id
    const b = bus.register({ agentSessionId: SESSION, instruction: 'B' }).task.id
    bus.onSignal({ type: 'error', sessionId: SESSION, message: '失败' })
    bus.onSignal({ type: 'released', sessionId: SESSION })
    expect(describeTask(bus.find(b))).toContain('已挂起')
    bus.resumeTask(a)
    bus.onSignal({ type: 'done', sessionId: SESSION })
    bus.onSignal({ type: 'released', sessionId: SESSION })
    expect(started).toEqual([])
    expect(bus.find(b)?.status).toBe('queued')
  })

  it('跑完之后那条会话又能派新活了', () => {
    register()
    bus.onSignal({ type: 'done', sessionId: SESSION })

    const next = bus.register({ agentSessionId: SESSION, instruction: '下一件' })
    expect(next.action).toBe('queued')
    bus.resume()
    expect(started).toEqual([])
    bus.onSignal({ type: 'released', sessionId: SESSION })
    expect(started).toEqual(['下一件'])
  })

  it('先到的终态说了算 —— 「失败了」不能被随后的 agent_end 盖成「已完成」', () => {
    // pi 在报错之后照样会发 agent_end，不挡的话用户听到的是最坏的一种谎
    const id = register()

    bus.onSignal({ type: 'error', sessionId: SESSION, message: '连不上编辑器' })
    bus.onSignal({ type: 'done', sessionId: SESSION })

    expect(bus.find(id)?.status).toBe('failed')
    expect(announced.filter((item) => item.context.includes('已完成'))).toHaveLength(0)
    expect(spoken.at(-1)).toContain('没做成')
  })

  it('只在换了阶段时播进度，同一阶段调十次工具不念十遍', () => {
    register()

    bus.onSignal({ type: 'tool', sessionId: SESSION, toolName: 'blueprint_add_variable' })
    clock += PROGRESS_THROTTLE_MS
    bus.onSignal({ type: 'tool', sessionId: SESSION, toolName: 'blueprint_apply_graph' })
    clock += PROGRESS_THROTTLE_MS
    bus.onSignal({ type: 'tool', sessionId: SESSION, toolName: 'blueprint_compile' })

    expect(spoken).toEqual(['在改蓝图。'])
    expect(announced.at(-1)?.context).toBe('任务 t1 在改蓝图。')
  })

  /*
   * 真机 2026-09-17：用户问「他那个动画蓝图是怎么选的」，Agent 只是读，
   * 语音却报「在改蓝图」——「它是不是把我的蓝图动了」是用户最在意的一条线，
   * 不能靠命名空间一刀切。
   */
  it('只读的那几步说「在看」，真动手了才说「在改」', () => {
    register()

    bus.onSignal({ type: 'tool', sessionId: SESSION, toolName: 'blueprint_describe' })
    clock += PROGRESS_THROTTLE_MS
    bus.onSignal({ type: 'tool', sessionId: SESSION, toolName: 'blueprint_get_graph' })
    clock += PROGRESS_THROTTLE_MS
    bus.onSignal({ type: 'tool', sessionId: SESSION, toolName: 'blueprint_apply_graph' })

    expect(spoken).toEqual(['在看蓝图。', '在改蓝图。'])
  })

  it('用户在说话时压着不播，说完了再放出去', () => {
    register()
    floor = { active: true, userSpeaking: true, assistantSpeaking: false }

    bus.onSignal({ type: 'error', sessionId: SESSION, message: '失败' })
    expect(spoken).toEqual([])

    floor = { active: true, userSpeaking: false, assistantSpeaking: false }
    bus.flush()
    expect(spoken).toHaveLength(1)
  })

  /*
   * 豆包那条链路是 TTS 直合成，没有文字增量，渲染层看不见「它在念」。
   * 不按字数估个念完时间的话，两条播报会叠在一起念。
   */
  it('上一条还在念的时候不放下一条，估计念完了再放', () => {
    register('第一件', 'session-a')
    register('第二件', 'session-b')

    bus.onSignal({ type: 'error', sessionId: 'session-a', message: '失败' })
    bus.onSignal({ type: 'error', sessionId: 'session-b', message: '也失败' })
    expect(spoken).toHaveLength(1)

    clock += estimateSpeechMs(spoken[0]) - 1
    bus.flush()
    expect(spoken).toHaveLength(1)

    clock += 1
    bus.flush()
    expect(spoken).toHaveLength(2)
  })

  it('用户在界面上把问题答掉了，还压着没念的那条作废', () => {
    register()
    floor = { active: true, userSpeaking: true, assistantSpeaking: false }
    bus.onSignal({
      type: 'question',
      sessionId: SESSION,
      toolCallId: 'call-9',
      questions: [QUESTION]
    })
    expect(spoken).toEqual([])

    bus.onSignal({ type: 'question-settled', sessionId: SESSION, toolCallId: 'call-9' })
    floor = { active: true, userSpeaking: false, assistantSpeaking: false }
    bus.flush()

    // 念出来是在问一个已经答掉的问题
    expect(spoken).toEqual([])
  })

  it('别人在界面上打字跑的运行不归我们管', () => {
    bus.onSignal({ type: 'done', sessionId: 'someone-else' })

    expect(spoken).toEqual([])
    expect(bus.snapshot()).toEqual([])
  })

  it('Agent 反问用户时等模型说完再念，并留下 toolCallId 好把答案送回去', () => {
    const id = register()
    floor = { active: true, userSpeaking: false, assistantSpeaking: true }

    bus.onSignal({
      type: 'question',
      sessionId: SESSION,
      toolCallId: 'call-9',
      questions: [QUESTION]
    })

    // 模型正在说话时不打断：往正在生成的模型里塞 TTS，真机上会把整路会话弄哑
    expect(spoken).toEqual([])
    floor = { active: true, userSpeaking: false, assistantSpeaking: false }
    bus.flush()
    expect(spoken.at(-1)).toContain('要冷色还是暖色')
    // 用户听见的是问题本身，「把答案交回来」那条指令只给模型
    expect(spoken.at(-1)).not.toContain('answer_question')
    expect(announced.at(-1)?.context).toContain('answer_question')
    expect(bus.pendingQuestion(id)?.toolCallId).toBe('call-9')
  })

  /*
   * 审批比反问更要紧：反问超时按取消算，审批**超时按拒绝算**，还要等五分钟。
   * 用户戴着耳机没看屏幕的话，那五分钟里他完全不知道有个确认框在等他，
   * 最后只听说「这一步被拒绝了」——而他从头到尾没点过拒绝。
   */
  it('Agent 卡在审批上要念出来，而且要念清楚是哪个工具', () => {
    const id = register()

    bus.onSignal({
      type: 'approval',
      sessionId: SESSION,
      toolCallId: 'call-approve',
      toolName: 'ue_destroy_actor',
      risk: 'high',
      allowAlways: true
    })

    // 念工具名，不是含糊的「一个高风险操作」——用户要凭它判断该不该点头
    expect(spoken.at(-1)).toContain('ue_destroy_actor')
    // 「别替用户决定」那条指令只给模型，用户不该听见
    expect(spoken.at(-1)).not.toContain(APPROVE_TASK)
    expect(announced.at(-1)?.context).toContain(APPROVE_TASK)
    expect(bus.pendingApproval(id)?.toolCallId).toBe('call-approve')
  })

  it('审批在界面上被点掉之后，语音这边不再认为有人在等', () => {
    const id = register()
    bus.onSignal({
      type: 'approval',
      sessionId: SESSION,
      toolCallId: 'call-approve',
      toolName: 'ue_destroy_actor',
      risk: 'high',
      allowAlways: false
    })

    bus.onSignal({ type: 'approval-settled', sessionId: SESSION, toolCallId: 'call-approve' })

    expect(bus.pendingApproval(id)).toBeUndefined()
  })

  it('问题在界面上被答掉之后，语音这边不再认为有人在等', () => {
    const id = register()
    bus.onSignal({
      type: 'question',
      sessionId: SESSION,
      toolCallId: 'call-9',
      questions: [QUESTION]
    })

    bus.onSignal({ type: 'question-settled', sessionId: SESSION, toolCallId: 'call-9' })

    expect(bus.pendingQuestion(id)).toBeUndefined()
  })

  /*
   * 用户刚交代完第二件、紧接着说「算了别做那件」。少了这一支的表现是
   * 语音回一句「现在没有在跑的任务」—— 它明明刚记下来。
   */
  it('还排着队的活撤得掉，而且不影响正在跑的那件', () => {
    register('第一件')
    const second = bus.register({ agentSessionId: SESSION, instruction: '第二件' })
    const secondId = second.action === 'queued' ? second.task.id : ''

    expect(bus.dropQueued(secondId)).toBe(true)
    expect(bus.find(secondId)?.status).toBe('stopped')
    // 不播报：这件活没开始过，「刚才那件事停下了」念出来是错的，
    // 而且工具返回值已经让模型告诉用户了，再播就是同一句说两遍
    expect(spoken).toEqual([])

    // 撤掉的那件不该在前面那件结束时被推出去跑
    bus.onSignal({ type: 'done', sessionId: SESSION })
    bus.onSignal({ type: 'released', sessionId: SESSION })
    expect(started).toEqual([])
  })

  it('正在跑的那件不能靠撤队列了结 —— 那得走真正的停止', () => {
    const id = register()

    expect(bus.dropQueued(id)).toBe(false)
    expect(bus.find(id)?.status).toBe('running')
  })

  it('启动失败要标掉，否则那条会话永远派不进新活', () => {
    const id = register()

    bus.abandon(id, '会话正在执行中')

    expect(bus.find(id)?.status).toBe('failed')
    expect(bus.register({ agentSessionId: SESSION, instruction: '再来' }).action).toBe('start')
  })

  it('语音关了，攒着的不会在下一次 flush 时冒出来', () => {
    register()
    floor = { active: true, userSpeaking: true, assistantSpeaking: false }
    bus.onSignal({ type: 'error', sessionId: SESSION, message: '失败' })

    bus.clearQueue()
    floor = { active: true, userSpeaking: false, assistantSpeaking: false }
    bus.flush()

    expect(spoken).toEqual([])
  })

  /*
   * 用户挂了语音去干别的，回来再开：刚才派的活做完了得有人告诉他，Agent 问的话
   * 也得再念一遍。上一版直接丢，他只能自己想起来问「刚才那个好了没」。
   */
  describe('挂断再接上', () => {
    /** 把队里排着的都念完（每念一条把时钟拨过它的播放时长） */
    function drain(): void {
      for (let i = 0; i < 10; i += 1) {
        // 上一条还在念的时候不放下一条，先把时钟拨过它
        if (spoken.length > 0) clock += estimateSpeechMs(spoken[spoken.length - 1])
        const before = spoken.length
        bus.flush()
        if (spoken.length === before) return
      }
    }

    it('不在线期间做完的活，接上时补念结果', () => {
      register('把灯调暗')
      bus.onSignal({ type: 'text', sessionId: SESSION, text: '灯已经调暗了。' })
      floor = { active: false, userSpeaking: false, assistantSpeaking: false }

      bus.onSignal({ type: 'done', sessionId: SESSION })
      bus.onSignal({ type: 'released', sessionId: SESSION })
      expect(spoken).toEqual([])

      floor = { active: true, userSpeaking: false, assistantSpeaking: false }
      bus.briefOnReconnect()
      drain()

      expect(spoken[0]).toContain('接上了')
      expect(spoken[1]).toContain('灯已经调暗了')
    })

    /*
     * 真机（2026-09-03 12:21）：
     *
     *   [语音播报 12:21:30.959] 插播：接上了。你不在的时候有几件事：
     *   [豆包实时语音 12:21:31.870] ↑ session.create   ← 会话晚了 900 毫秒才开始建
     *
     * 上一版一 `openSession` 返回就把 `floor.active` 置真、当场 `briefOnReconnect`，
     * 而那会儿 WebSocket 还没握完手。用户听到的是**系统嗓音念了半句** ——
     * 豆包没收到，两秒半后退回本机合成；剩下几条还压在队里，会话就被关了。
     *
     * 闸门现在由 `ipc/realtimeVoice.ts` 的 `vendorReady` 控制（收到 `ready` 才开）。
     * 任务表这边要保证的是：闸门关着时**一条都不放，而且一条都不丢**。
     */
    it('厂商还没就绪时一个字都不放，就绪后一条不落地补上', () => {
      // 会话建起来了但厂商还没回 ready —— 这段时间里活跑完了
      floor = { active: false, userSpeaking: false, assistantSpeaking: false }
      register('搬资产')
      bus.onSignal({ type: 'text', sessionId: SESSION, text: '搬完了。' })
      bus.onSignal({ type: 'done', sessionId: SESSION })
      bus.onSignal({ type: 'released', sessionId: SESSION })

      expect(spoken).toEqual([])

      // ready 到了
      floor = { active: true, userSpeaking: false, assistantSpeaking: false }
      bus.briefOnReconnect()
      drain()

      expect(spoken[0]).toContain('接上了')
      expect(spoken.join('')).toContain('搬完了')
    })

    it('不在线期间的中途进度不补 —— 那是过去式', () => {
      register()
      floor = { active: false, userSpeaking: false, assistantSpeaking: false }
      bus.onSignal({ type: 'tool', sessionId: SESSION, toolName: 'blueprint_compile' })
      floor = { active: true, userSpeaking: false, assistantSpeaking: false }

      bus.briefOnReconnect()
      drain()

      // 旧进度那条（「在改蓝图。」）不当新闻念；只提一句「还在跑」，顺带说它现在在哪一步
      expect(spoken).not.toContain('在改蓝图。')
      expect(spoken.some((line) => line.includes('还在跑'))).toBe(true)
    })

    it('挂断前问过、还没人答的反问，接上时再念一遍', () => {
      register()
      bus.onSignal({
        type: 'question',
        sessionId: SESSION,
        toolCallId: 'call-9',
        questions: [QUESTION]
      })
      expect(spoken).toHaveLength(1)
      clock += estimateSpeechMs(spoken[0])

      bus.clearQueue()
      bus.briefOnReconnect()
      drain()

      const asked = announced.filter((item) => item.speech.includes('要冷色还是暖色'))
      expect(asked).toHaveLength(2)
      // 带着 kind，渲染层据此重新架起「下一句当答案」的保险
      expect(asked[1].kind).toBe('question')
    })

    it('不在线期间在界面上答掉的问题，接上时不再念', () => {
      register()
      floor = { active: false, userSpeaking: false, assistantSpeaking: false }
      bus.onSignal({
        type: 'question',
        sessionId: SESSION,
        toolCallId: 'call-9',
        questions: [QUESTION]
      })
      bus.onSignal({ type: 'question-settled', sessionId: SESSION, toolCallId: 'call-9' })
      floor = { active: true, userSpeaking: false, assistantSpeaking: false }

      bus.briefOnReconnect()
      drain()

      expect(spoken.some((line) => line.includes('要冷色还是暖色'))).toBe(false)
    })

    it('什么都没发生就一个字不说', () => {
      floor = { active: true, userSpeaking: false, assistantSpeaking: false }

      bus.briefOnReconnect()
      drain()

      expect(spoken).toEqual([])
    })
  })

  describe('progressSpeech（防冷场主动汇报）', () => {
    it('一件在跑都没有就什么都不报', () => {
      expect(bus.progressSpeech()).toBeNull()
    })

    it('报的是 Agent 自己那句进度，不是「灶」这种内部说法', () => {
      register('把主灯调暗')
      bus.onSignal({ type: 'report', sessionId: SESSION, status: 'running', message: '在改蓝图' })

      const progress = bus.progressSpeech()

      expect(progress?.speech).toBe('跟你说一声，「把主灯调暗」在改蓝图。')
      expect(progress?.speech).not.toContain('灶')
    })

    /*
     * 真机（2026-09-05）：两件活的原话被整段念了回去，一句话四十多秒，
     * 而用户几分钟前刚说完那两段。兜底这句只留「做什么」那半截。
     */
    it('兜底那句不复述整段指令', () => {
      bus.register({
        agentSessionId: 'session-boat',
        instruction:
          '把关卡里的游轮改成泰坦尼克号风格：调整船体造型、增加多层客舱、加装救生艇、改配色为黑 hull 白上层建筑，还原经典外观'
      })

      const progress = bus.progressSpeech()

      expect(progress?.speech).toContain('把关卡里的游轮改成泰坦尼克号风格')
      expect(progress?.speech).not.toContain('救生艇')
    })

    it('交给模型压的那份带上原话和已经做了多久 —— 简称和新意都从这儿来', () => {
      register('把主灯调暗')
      clock += 120_000

      const facts = bus.progressSpeech()?.facts ?? ''

      expect(facts).toContain('把主灯调暗')
      expect(facts).toContain('2 分钟')
    })

    it('卡着等人的那件要说成「等你点头」，不能报成还在跑', () => {
      register('删掉旧资产')
      bus.onSignal({
        type: 'approval',
        sessionId: SESSION,
        toolCallId: 'call-1',
        toolName: 'ue_delete_asset',
        risk: 'high',
        allowAlways: false
      })

      expect(bus.progressSpeech()?.speech).toContain('停在一个要你点头的操作上')
    })
  })

  it('不给任务号就查最近那一件', () => {
    register('第一件', 'session-a')
    register('第二件', 'session-b')

    expect(bus.find()?.instruction).toBe('第二件')
  })
})
