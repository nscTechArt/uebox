import { randomUUID } from 'node:crypto'
import type { ThinkingLevel } from '@earendil-works/pi-ai'
import { thinkingOffFields } from '../../agent-v3/core/piModel'
import { resolveBinding, resolveModel } from '../piCompletion'
import { synthesizeSpeech } from '../speech'
import { hasSttAdapter, openSttSession, resolveSttBinding } from '../stt'
import { isPlanProvider } from '../../../shared/creatorPlan'
import { missingForVoicePipeline } from '../../../shared/aiProvider'
import type { AiProviderSettings } from '../types'
import type { CascadeDeps } from './cascadeRealtime'

/**
 * 拼装通话的三样依赖：从「语音识别」「语音合成」和对话模型三个角色里接出来。
 *
 * 和编排（`cascadeRealtime.ts`）分开放，是因为这三样都要读配置、解密钥 ——
 * 一 import 就把 electron 拖进来，编排那边就没法单测了。
 */

/**
 * 脑子用哪个角色：**轻量任务**，没配就落到对话模型（`ROLE_FALLBACK.summary`）。
 *
 * 语音前台要的是快 —— 一两句话、调一下派活的工具。主力对话模型常常是开着长思考的
 * 大模型，拿它当前台，用户每句话都要多等好几秒。用户专门挑了一个轻量模型的话，
 * 那正是这里要的。
 */
const BRAIN_ROLE = 'summary' as const

/** 三样配齐没有。判断本身在 shared（设置页用同一份），这里补上「识别认不认得这个地址」 */
export function missingForCascade(settings: AiProviderSettings): string[] {
  return missingForVoicePipeline(settings, (provider) =>
    hasSttAdapter(provider.baseUrl, isPlanProvider(provider.id))
  )
}

/** 接出三样依赖。密钥在这里解，坏了当场报，不等到用户开口才发现 */
export async function createCascadeDeps(): Promise<CascadeDeps> {
  const sttBinding = await resolveSttBinding()
  if (!sttBinding) throw new Error('还没有配置「语音识别」模型。')
  const { provider, modelId } = await resolveBinding({ role: BRAIN_ROLE })
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
      })
  }
}
