import { randomUUID } from 'node:crypto'
import type { ThinkingLevel } from '@earendil-works/pi-ai'
import { thinkingOffFields } from '../../agent-v3/core/piModel'
import { judge } from '../judge'
import { resolveBinding, resolveModel } from '../piCompletion'
import { synthesizeSpeech } from '../speech'
import { readSettings } from '../store'
import { hasSttAdapter, openSttSession, resolveSttBinding } from '../stt'
import { isPlanProvider } from '../../../shared/creatorPlan'
import { missingForVoicePipeline } from '../../../shared/aiProvider'
import type { AiProviderSettings, ModelBinding } from '../types'
import type { CascadeDeps, UtteranceVerdict } from './cascadeRealtime'

/**
 * 拼装通话的三样依赖：从「语音识别」「语音合成」和对话模型三个角色里接出来。
 *
 * 和编排（`cascadeRealtime.ts`）分开放，是因为这三样都要读配置、解密钥 ——
 * 一 import 就把 electron 拖进来，编排那边就没法单测了。
 */

/**
 * 判一句话要等多久。判定模型约 100ms 回；超过这个数就当判不了、按老规矩当真 ——
 * 用户正等着它停下来听他说，不能为了判这一下让他干等。
 */
const JUDGE_TIMEOUT_MS = 1_500

/** 三样配齐没有。判断本身在 shared（设置页用同一份），这里补上「识别认不认得这个地址」 */
export function missingForCascade(settings: AiProviderSettings): string[] {
  return missingForVoicePipeline(settings, (provider) =>
    hasSttAdapter(provider.baseUrl, isPlanProvider(provider.id))
  )
}

/**
 * 脑子用哪个模型：**输入框当前选的那个**。
 *
 * 所见即所得 —— 输入框上写着 deepseek-flash，接电话的就该是它。上一版用的是
 * 「轻量任务」角色，用户在界面上看不到这层关系：他那里轻量任务绑的模型首字要
 * 十几秒，而输入框显示的那个只要一秒多，他只能觉得「语音怎么这么慢」（真机 2026-10-14）。
 *
 * 这条对话没单独选过模型，就用 Agent 的默认（`ROLE_FALLBACK.agent`），和输入框显示的一致。
 * 思考一律关掉（见 `reply`），所以选了大模型也只是慢一点、贵一点，不会每句先想半天。
 */
async function resolveBrain(
  pinned?: ModelBinding
): Promise<{ provider: AiProviderSettings['providers'][number]; modelId: string }> {
  if (pinned) {
    const settings = await readSettings()
    const provider = settings.providers.find(
      (item) => item.id === pinned.providerId && item.kind === 'chat'
    )
    // 对话钉着的模型被删了：退回默认，和输入框的处理一致
    if (provider) return { provider, modelId: pinned.modelId }
  }
  const { provider, modelId } = await resolveBinding({ role: 'agent' })
  return { provider, modelId }
}

/** 读判定模型的一个是非题。没答这一题回 undefined */
function noul(
  answers: Record<string, { type: string; noul?: number }>,
  key: string
): number | undefined {
  const answer = answers[key]
  return answer?.type === 'noul' && typeof answer.noul === 'number' ? answer.noul : undefined
}

/** 接出三样依赖。密钥在这里解，坏了当场报，不等到用户开口才发现 */
export async function createCascadeDeps(brain?: ModelBinding): Promise<CascadeDeps> {
  const sttBinding = await resolveSttBinding()
  if (!sttBinding) throw new Error('还没有配置「语音识别」模型。')
  const { provider, modelId } = await resolveBrain(brain)
  const { models, model } = resolveModel(provider, modelId)
  // 一通电话一个会话 id：厂商据此做前缀缓存，系统提示词和工具表每轮都一样
  const sessionId = randomUUID()
  const offFields = thinkingOffFields(provider.baseUrl)

  return {
    openStt: (onEvent) => openSttSession(sttBinding, onEvent),
    reply: ({ system, messages, tools, signal }) =>
      models.streamSimple(
        model,
        { systemPrompt: system, messages, tools },
        {
          sessionId,
          signal,
          // 关掉思考：前台一句话的事，等它想几秒用户以为没听见。关不掉的模型 pi 会夹到最低档
          reasoning: 'off' as unknown as ThinkingLevel,
          ...(offFields ? { samplingParams: offFields } : {})
        }
      ),
    speak: (text, signal, onAudio) =>
      synthesizeSpeech(text, signal, onAudio).catch((error: unknown) => {
        // 合成那边抛的是错误码（TTS_HTTP_401 …），原样说给用户听的话他看不懂是哪一环坏了
        const code = error instanceof Error ? error.message : String(error)
        throw new Error(`语音合成失败（${code}），请检查「语音合成」模型的配置。`)
      }),
    /*
     * 没绑判定模型时 `judge` 回 null（它的契约就是永不抛），编排那边按老规矩当真。
     * 两道题一次问完：「是不是在对它说话」「它忙着时是不是要打断它」。
     */
    judgeUtterance: async ({ text, assistantSaying, busy, asrTags }) => {
      const result = await judge(
        {
          assistant_saying: assistantSaying.slice(-300),
          user_said: text,
          ...(asrTags?.length ? { asr_tags: asrTags } : {})
        },
        {
          addressed: {
            type: 'noul',
            instructions:
              '语音通话里，user_said 是语音识别从麦克风里认出来的一句话。它是用户在对语音助手说话吗？',
            criteria: {
              true: '提问、下指令、回答或确认助手的问题、纠正助手、叫它停下或等一等',
              false:
                '杂音、咳嗽、敲键盘被误认出来的零碎字词；和 assistant_saying 几乎一样（喇叭的声音被麦克风收了回来）；明显是在跟旁人说话或自言自语'
            }
          },
          ...(busy
            ? {
                interrupt: {
                  type: 'noul' as const,
                  instructions:
                    '助手正在说话或正在准备回答（assistant_saying 是它正在说的），用户说了 user_said。用户是想让助手停下来、改说别的、或者直接回答它刚问的问题吗？',
                  criteria: {
                    true: '提出新问题或新要求、纠正、叫停、回答助手的问题',
                    false: '只是附和（嗯、对、好、是的）表示在听，或者等得不耐烦的语气词'
                  }
                }
              }
            : {})
        },
        { timeoutMs: JUDGE_TIMEOUT_MS }
      )
      if (!result) return null
      const answers = result.answers as Record<string, { type: string; noul?: number }>
      const addressed = noul(answers, 'addressed')
      if (addressed === undefined) return null
      const interrupt = busy ? noul(answers, 'interrupt') : undefined
      const verdict: UtteranceVerdict = {
        addressed,
        ...(interrupt !== undefined ? { interrupt } : {})
      }
      console.log(
        `[拼装通话] 判定「${text}」：在对它说话 ${addressed.toFixed(2)}${interrupt !== undefined ? `，要打断 ${interrupt.toFixed(2)}` : ''}`
      )
      return verdict
    }
  }
}
