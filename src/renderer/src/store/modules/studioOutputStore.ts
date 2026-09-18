import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { KnowledgeGraphData } from '../../services/knowledgeGraph/types'
import type { BrainstormSession } from '../../services/brainstorm/types'
import { studioOutputsAPI } from '@renderer/api/studioOutputs'
import { message } from '@renderer/utils/messageManager'
import i18n from '@renderer/i18n'

/**
 * 面试配置接口
 */
export interface InterviewConfig {
  /** 面试主题 */
  topic: string
  /** 考察知识点列表 */
  knowledgePoints: Array<{
    id: string
    title: string
    content: string
    type: 'Concept' | 'Method' | 'Tool' | 'Item' | 'Project' | 'Agent' | 'Event'
  }>
  /** 预设问题列表 */
  questions: Array<{
    id: string
    question: string
    sourceId: string
    sourceTitle: string
    /** 问题类型：choice=选择题, open=开放题 */
    questionType?: 'choice' | 'open'
    /** 选择题选项 */
    options?: Array<{ id: string; text: string }>
    /** 正确答案ID */
    correctAnswer?: string
    /** AI生成的提示 */
    hint?: string
    /** 答案解释 */
    explanation?: string
  }>
  /** 面试状态 */
  status: 'ready' | 'in-progress' | 'completed'
  /** 面试得分 */
  score?: number
}

/**
 * Studio 产出项目类型
 */
export interface StudioOutput {
  id: string
  type:
    | 'video'
    | 'mindmap'
    | 'report'
    | 'knowledgeGraph'
    | 'interview'
    | 'infographic'
    | 'webpage'
    | 'brainstorm'
  title: string
  sourceCount: number
  createdAt: string // ISO 格式时间戳，便于序列化
  /** 思维导图数据 */
  mindmapData?: unknown
  /** 报告内容 (Markdown) */
  reportContent?: string
  /** 知识图谱数据 */
  knowledgeGraphData?: KnowledgeGraphData
  /** 面试配置数据 */
  interviewConfig?: InterviewConfig
  /** 信息图图片数据 (base64 data URL 或 HTTP URL) */
  infographicImageUrl?: string
  /** 信息图本地文件路径，仅当前设备可用，不参与分享/同步 */
  infographicLocalPath?: string
  /** 网页 HTML 内容 */
  webpageHtml?: string
  /** 头脑风暴数据 */
  brainstormData?: BrainstormSession
  /** 任务状态：generating（生成中）、completed（已完成）、failed（失败） */
  status?: 'generating' | 'completed' | 'failed'
  /** 失败原因（仅当 status === 'failed' 时有效） */
  errorMessage?: string
}

/**
 * 按知识库存储的产出数据
 */
interface NotebookOutputs {
  [notebookId: string]: StudioOutput[]
}

/**
 * 老用户那份产出。
 *
 * 这个键以前是 pinia 的持久化目标（整包产出存在 localStorage 里）。现在只读不写，
 * 用来把老数据搬进保管库；搬成功一个知识库就从里面摘掉一个，全空了就删掉这个键。
 */
function readLegacyOutputs(): NotebookOutputs | null {
  try {
    const raw = localStorage.getItem('studio-outputs')
    if (!raw) return null
    const parsed = JSON.parse(raw)
    // pinia 存的是 { outputs: {...} }，早期也可能直接是 {...}
    const value = parsed?.outputs ?? parsed
    return value && typeof value === 'object' ? (value as NotebookOutputs) : null
  } catch {
    return null
  }
}

/** 某个知识库搬完了，从旧数据里摘掉它。全空了就把这个键删干净 */
function dropLegacyNotebook(notebookId: string): void {
  try {
    const legacy = readLegacyOutputs()
    if (!legacy) return
    delete legacy[notebookId]
    if (Object.keys(legacy).length === 0) {
      localStorage.removeItem('studio-outputs')
      return
    }
    localStorage.setItem('studio-outputs', JSON.stringify({ outputs: legacy }))
  } catch (error) {
    console.warn('[StudioOutputStore] 清理旧产出数据失败（不影响使用）:', error)
  }
}

function isLikelyLocalFilePath(value?: string): boolean {
  if (!value) return false
  return /^[a-zA-Z]:[\\/]/.test(value) || /^(\\\\|\/\/)/.test(value) || value.startsWith('file:///')
}

function hasInfographicAsset(output: StudioOutput): boolean {
  return Boolean(output.infographicImageUrl || output.infographicLocalPath)
}

/**
 * Studio 产出 Store
 * 用于存储和管理知识库的生成产出
 */
export const useStudioOutputStore = defineStore('studioOutputs', () => {
  // 所有知识库的产出数据
  const outputs = ref<NotebookOutputs>({})

  /**
   * 获取指定知识库的产出列表
   */
  function getOutputs(notebookId: string): StudioOutput[] {
    return outputs.value[notebookId] || []
  }

  /**
   * 每个知识库的读盘结果。
   *
   * **一个事实一个变量。** 这里原来是两个集合（读过的 / 读失败过的），而它们描述的是
   * 同一件事的两种取值；分成两个的直接后果是「成功」有多条出路、每条都得记着改状态，
   * 结果漏掉了「读成功且有内容」那一条 —— 那条恰好是最常见的路径，于是一次偶发的
   * 读失败会让这个知识库**整个会话都写不进去**。合成一个 Map 之后，
   * 成功只有一处赋值，漏不掉。
   *
   * - `'ok'`：读过了，内存里那份是完整的，可以写
   * - `'failed'`：这次读不出来。**读失败不等于没有产出** —— 磁盘上那份可能好着，
   *   只是被占用（杀软、索引器）或者 JSON 坏了。此时内存是空的，照着空的写下去
   *   就会把用户此前所有的报告、信息图整份顶掉。所以宁可这次存不上，也不能删掉旧的。
   * - 没有条目：还没读过
   */
  const loadState = new Map<string, 'ok' | 'failed'>()
  /** 有产出没写进磁盘。界面据此提示，别让用户以为存好了 */
  const saveFailed = ref(false)

  /**
   * 存不上这件事要让用户看见。
   *
   * 只靠 `saveFailed` 不够：产出列表里那一条照旧显示「已完成」，用户没有任何理由
   * 怀疑它只活在内存里，直到重启之后发现没了。但每次变更都弹一次也不行 ——
   * 一次生成会连着改好几次产出，会糊一屏。所以按知识库弹一次，之后只写日志。
   */
  const warnedNotebooks = new Set<string>()
  function warnSaveFailed(notebookId: string, detail: string): void {
    saveFailed.value = true
    console.error(`[StudioOutputStore] ${detail}（${notebookId}）`)
    if (warnedNotebooks.has(notebookId)) return
    warnedNotebooks.add(notebookId)
    message.error(i18n.global.t('notebook.studio.outputsSaveFailed'))
  }

  /**
   * 把一个知识库的产出写进保管库。
   *
   * 每次变更都写：这些东西一份可能几百 KB，但一个知识库的产出总量有限，
   * 而「少写一次 = 用户可能丢一份报告」的代价要大得多。
   */
  async function persistNotebook(notebookId: string): Promise<void> {
    // 这个知识库的产出没读出来过，内存里那份不完整 —— 写下去等于拿空的盖掉好的
    if (loadState.get(notebookId) === 'failed') {
      warnSaveFailed(notebookId, '之前读盘失败过，拒绝写入以免顶掉磁盘上的产出')
      return
    }

    try {
      await studioOutputsAPI.write(notebookId, JSON.stringify(outputs.value[notebookId] ?? []))
      saveFailed.value = false
      warnedNotebooks.delete(notebookId)
    } catch (error) {
      warnSaveFailed(notebookId, `产出没能写进保管库：${String(error)}`)
    }
  }

  /**
   * 读一个知识库的产出，顺带把老用户 localStorage 里那份搬过来。
   *
   * ## 迁移的底线
   *
   * 先写盘、写成功了才清 localStorage。反过来的话，写盘失败（保管库不在、没权限）
   * 就等于把用户此前所有的产出直接删了 —— 而那正是这次改动要防的事。
   * 迁移失败就保留原样，下次进这个知识库再试一次。
   */
  async function loadNotebook(notebookId: string): Promise<void> {
    // 读成功过就不再读；读失败过要允许重试（磁盘可能只是当时被占用）
    if (loadState.get(notebookId) === 'ok') return

    let hasContent = false
    try {
      const text = await studioOutputsAPI.read(notebookId)
      if (text) {
        outputs.value[notebookId] = JSON.parse(text) as StudioOutput[]
        normalizePersistedOutputs(notebookId)
        cleanupIncomplete(notebookId)
        hasContent = true
      }
      /*
        成功只在这一处落状态 —— 不管读回来的是内容还是空文件。
        这行原来在 `if (text) { … return }` 的**下面**，于是「读成功且有内容」这条
        最常见的路径压根走不到，一次偶发失败就把这个知识库永久锁成只读。
      */
      loadState.set(notebookId, 'ok')
    } catch (error) {
      // 读不出来时**不要**清空内存里的那份 —— 那可能是刚从 localStorage 迁过来还没写盘的。
      // 磁盘上那份可能好着，只是这次读不到。标记上，别让后续的写入把它顶掉
      loadState.set(notebookId, 'failed')
      warnSaveFailed(notebookId, `读取产出失败，本次不再写入：${String(error)}`)
      return
    }

    if (hasContent) return

    // 磁盘上没有：可能是老用户，产出还在 localStorage 的那份 legacy 数据里
    const legacy = readLegacyOutputs()
    const legacyList = legacy?.[notebookId]
    if (!legacyList?.length) return

    outputs.value[notebookId] = legacyList
    normalizePersistedOutputs(notebookId)
    cleanupIncomplete(notebookId)

    try {
      await studioOutputsAPI.write(notebookId, JSON.stringify(outputs.value[notebookId] ?? []))
      dropLegacyNotebook(notebookId)
    } catch (error) {
      // 写不进去就把 localStorage 那份留着，下次再搬
      saveFailed.value = true
      console.error(`[StudioOutputStore] 产出迁移失败，旧数据保留（${notebookId}）:`, error)
    }
  }

  /**
   * 兼容旧数据：把误存到 infographicImageUrl 的本地绝对路径迁移到本地专用字段
   */
  function normalizePersistedOutputs(notebookId: string): void {
    const list = outputs.value[notebookId]
    if (!list) return
    outputs.value[notebookId] = list.map((output) => {
      if (
        output.type === 'infographic' &&
        output.infographicImageUrl &&
        !output.infographicLocalPath &&
        isLikelyLocalFilePath(output.infographicImageUrl)
      ) {
        return {
          ...output,
          infographicImageUrl: undefined,
          infographicLocalPath: output.infographicImageUrl
        }
      }
      return output
    })
  }

  /**
   * 添加产出项目
   */
  function addOutput(notebookId: string, output: StudioOutput): void {
    if (!outputs.value[notebookId]) {
      outputs.value[notebookId] = []
    }
    // 添加到开头
    outputs.value[notebookId].unshift(output)
    void persistNotebook(notebookId)
  }

  /**
   * 更新产出项目
   */
  function updateOutput(
    notebookId: string,
    outputId: string,
    updates: Partial<StudioOutput>
  ): void {
    const list = outputs.value[notebookId]
    if (!list) {
      // 占位不在了（最常见是中途切了保管库）。落不了地，但不能装作没发生
      console.warn(
        `[StudioOutputStore] 产出 ${outputId} 写不回去：知识库 ${notebookId} 的列表已不在内存里`
      )
      return
    }

    const index = list.findIndex((o) => o.id === outputId)
    if (index >= 0) {
      outputs.value[notebookId][index] = {
        ...list[index],
        ...updates
      }
      void persistNotebook(notebookId)
    }
  }

  /**
   * 删除产出项目
   */
  function removeOutput(notebookId: string, outputId: string): void {
    const list = outputs.value[notebookId]
    if (!list) return

    const index = list.findIndex((o) => o.id === outputId)
    if (index >= 0) {
      outputs.value[notebookId].splice(index, 1)
      void persistNotebook(notebookId)
    }
  }

  /**
   * 清空指定知识库的所有产出
   */
  function clearOutputs(notebookId: string): void {
    delete outputs.value[notebookId]
    // 知识库删了，它的产出文件也一起删 —— 确认框里说过这件事
    void studioOutputsAPI.remove(notebookId)
  }

  /**
   * 清理未完成的产出项目
   * 用于处理页面刷新后残留的"生成中"状态项目
   * 将未完成的项目标记为失败状态，以便用户了解刷新导致任务中断
   *
   * ## 为什么必须限定知识库，而且只在刚读完盘时调
   *
   * 这个判断的依据是「状态不是终态、数据又是空的」—— 而**正在生成**的产出长得
   * 一模一样。所以它只能作用在**刚从磁盘读回来的那一份**上：那份里的「生成中」
   * 必然是上次退出留下的残留，不可能是正在跑的任务。
   *
   * 扫全量一定是错的：`loadNotebook` 每进一个知识库都会调，进知识库 B 就会把
   * 知识库 A 里正在跑的那份报告改成「页面刷新导致任务中断」，用户看见失败又点一次
   * 重新生成，白花一次钱。所以参数是必填的，没有「不给就全扫」这条路。
   */
  function cleanupIncomplete(notebookId: string): void {
    const list = outputs.value[notebookId]
    if (!list) return
    outputs.value[notebookId] = list.map((output) => {
      // 如果已标记为失败或完成，保留原样
      if (output.status === 'failed' || output.status === 'completed') {
        return output
      }
      // 以下处理 status 为 'generating' 或未设置的情况（兼容旧数据）
      // 检查是否为未完成的产出，并标记为失败
      const isIncomplete =
        (output.type === 'mindmap' && !output.mindmapData) ||
        (output.type === 'report' && !output.reportContent) ||
        (output.type === 'knowledgeGraph' && !output.knowledgeGraphData) ||
        (output.type === 'interview' &&
          (!output.interviewConfig || !output.interviewConfig.questions?.length)) ||
        (output.type === 'infographic' && !hasInfographicAsset(output)) ||
        (output.type === 'webpage' && !output.webpageHtml) ||
        (output.type === 'brainstorm' && !output.brainstormData)

      if (isIncomplete) {
        console.log(`[StudioOutputStore] 标记未完成的${output.type}产出为失败: ${output.id}`)
        return {
          ...output,
          status: 'failed' as const,
          errorMessage: '页面刷新导致任务中断，请重新生成'
        }
      }
      return output
    })
  }

  /**
   * 换保管库了，内存里这份全作废。
   *
   * 产出文件是跟着保管库走的（`<保管库>/Notebook/<id>/outputs.json`），所以切库之后
   * 内存里那份属于**上一个库**。不清的话：`loadState` 还记着这个知识库读过，
   * `loadNotebook` 直接短路返回，界面显示的是旧库的产出；再生成一份，
   * `persistNotebook` 就把旧库的产出连带写进新库的目录里。
   *
   * ## 正在生成的那些要说一声
   *
   * 清内存会把「生成中」的占位一起带走，于是那次生成跑完时 `updateOutput` 找不到
   * 列表、直接 return —— 用户花钱买的报告无声无息地没了，连个失败状态都没有。
   * 救不回来（结果属于上一个库，现在已经写不过去了），但**不能当没发生**。
   *
   * @returns 被中断的生成份数，调用方据此提示用户
   */
  function resetForVaultSwitch(): number {
    let interrupted = 0
    for (const list of Object.values(outputs.value)) {
      for (const output of list) {
        if (output.status !== 'completed' && output.status !== 'failed') interrupted += 1
      }
    }

    outputs.value = {}
    loadState.clear()
    warnedNotebooks.clear()
    saveFailed.value = false

    if (interrupted > 0) {
      console.warn(`[StudioOutputStore] 切换保管库中断了 ${interrupted} 份正在生成的产出`)
      message.warning(i18n.global.t('notebook.studio.outputsInterruptedByVaultSwitch'))
    }
    return interrupted
  }

  return {
    outputs,
    /** 有产出没写进保管库。界面据此提示 */
    saveFailed,
    getOutputs,
    /** 进知识库时调一次：从保管库读回来，顺带迁移老用户 localStorage 里那份 */
    loadNotebook,
    addOutput,
    updateOutput,
    removeOutput,
    clearOutputs,
    /*
      `cleanupIncomplete` 不导出：它只有在「刚读完盘」这一刻是安全的，
      在别的时机调会把**正在生成**的产出判成失败。让外面拿不到，就不会有人调错时机。
    */
    /** 切保管库时调：内存里那份属于上一个库，留着会写串。返回被中断的生成份数 */
    resetForVaultSwitch
  }
})
