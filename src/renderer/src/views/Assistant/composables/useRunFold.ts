/**
 * 整轮做完之后，最后那段正文之前的东西收成一行「用时 · 步数」。
 *
 * 用户回头看一条做完的消息，要的是「交付了什么」；中间那几十步怎么走过来的，
 * 想查时点开就在。一轮只有一两块的不收 —— 收成一行和原样摆着差不多长。
 * 还有没答的提问时也不收：那是要用户动手的东西，藏起来就没人答了。
 *
 * 主对话页和小窗共用这一份：两边收不收、收到哪、那一行怎么说必须一致。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AgentProcessItem } from '../components/AgentProcessLog.types'
import { buildStepGroup } from '../components/agentSteps'
import { formatStepDuration } from '../components/agentStepLabels'
import type { AgentDisplayBlock } from './agentTimeline'

export interface RunFold {
  /** 收起时藏掉前面几块 */
  hiddenCount: number
  label: string
  /** 藏起来的那些步骤里产出的图和视频 —— 它们不能跟着藏，挂在交付下面 */
  images: string[]
  videos: string[]
}

export interface RunFoldOptions {
  blocks: Ref<AgentDisplayBlock[]> | ComputedRef<AgentDisplayBlock[]>
  done: () => boolean
  items: () => AgentProcessItem[] | undefined
  startTime: () => number | undefined
}

export function useRunFold(options: RunFoldOptions): {
  runFold: ComputedRef<RunFold | null>
  runExpanded: Ref<boolean>
  visibleBlocks: ComputedRef<AgentDisplayBlock[]>
  toggleRunFold: () => void
} {
  const { t } = useI18n()
  const runExpanded = ref(false)

  const runFold = computed<RunFold | null>(() => {
    if (!options.done()) return null
    const blocks = options.blocks.value
    let finalText = -1
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].kind === 'text') {
        finalText = i
        break
      }
    }
    if (finalText < 2) return null

    const hidden = blocks.slice(0, finalText)
    if (hidden.some((block) => block.kind === 'question' && !block.question.action)) return null
    const groups = hidden.flatMap((block) =>
      block.kind === 'steps' ? [buildStepGroup(block.parts)] : []
    )
    if (groups.length === 0) return null

    const items = options.items() ?? []
    const start = options.startTime() ?? items[0]?.timestamp
    const end = items[items.length - 1]?.timestamp
    const count = groups.reduce((sum, group) => sum + group.toolCount, 0)
    const label = [
      start !== undefined && end !== undefined
        ? t('assistant.agentProcess.steps.runTook', {
            duration: formatStepDuration(end - start, t)
          })
        : '',
      count > 0 ? t('assistant.agentProcess.steps.runSteps', { count }) : ''
    ]
      .filter(Boolean)
      .join(' · ')

    return {
      hiddenCount: finalText,
      label: label || t('assistant.agentProcess.processFinished'),
      images: groups.flatMap((group) => group.deliverableImages),
      videos: groups.flatMap((group) => group.videos)
    }
  })

  const visibleBlocks = computed(() =>
    runFold.value && !runExpanded.value
      ? options.blocks.value.slice(runFold.value.hiddenCount)
      : options.blocks.value
  )

  function toggleRunFold(): void {
    runExpanded.value = !runExpanded.value
  }

  return { runFold, runExpanded, visibleBlocks, toggleRunFold }
}
