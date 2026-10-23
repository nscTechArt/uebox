/**
 * 给游戏角色设计音色：`design_voice` 出试听 → 用户听 → `adopt_voice` 入表。
 *
 * 入表这一步**每次都弹确认卡**（`requiresExplicitApproval`），「本对话内都允许」也盖不住。
 * 声音好不好听模型判断不了，只能人听；把关做在审批门里，而不是指望模型记得先问
 * （用户开了「全部权限」就是说过不用问，那时照常放行）。
 *
 * 配音那头（`generate_speech` 的 `role`）只认采用过的音色，试听中的用不了。
 */

import { z } from 'zod'
import { defineTool, type UnrealAgentTool } from '../defineTool'
import type { VoiceCastEntry, VoiceCastRole } from '../../../services/taskVideo/voiceCast'
import type { ProviderConfig } from '../../../ai/types'

/** 这条对话归属工程的 `.uebox`；没有工程就说清楚为什么做不了 */
export async function currentCastDir(): Promise<string> {
  const { getSessionProjectPath, getTargetProjectPath } = await import(
    '../../core/projectTargetContext'
  )
  const { voiceCastDir } = await import('../../../services/taskVideo/voiceCast')
  const dir = voiceCastDir(getSessionProjectPath() ?? getTargetProjectPath())
  if (!dir)
    throw new Error('角色音色表存在 UE 工程里，这条对话还没有归属工程。先打开或指定要做的工程。')
  return dir
}

/** 音色记着的来源和模型，从当前设置里找回来。来源删了、模型换了就用不了 */
export async function castBinding(
  role: string,
  entry: VoiceCastEntry
): Promise<{ provider: ProviderConfig; modelId: string }> {
  const { readSettings } = await import('../../../ai/store')
  const provider = (await readSettings()).providers.find(
    (item) => item.id === entry.providerId && item.kind === 'tts'
  )
  if (!provider || !provider.models.some((model) => model.id === entry.modelId))
    throw new Error(
      `「${role}」的音色是在 ${entry.modelId} 上设计的，模型来源里已经没有这个模型了。` +
        '把它加回来，或者给这个角色重新设计音色。'
    )
  return { provider, modelId: entry.modelId }
}

async function apiKey(provider: ProviderConfig): Promise<string> {
  const { resolveApiKey } = await import('../../../ai/credentials')
  const key = await resolveApiKey(provider.apiKey)
  if (!key) throw new Error('语音合成来源没有填 API Key。请到偏好设置 → 模型来源补上。')
  return key
}

/** 删掉百炼上不再用的音色，腾出额度。删不掉不挡主流程：多占一个名额，不是错 */
async function releaseVoice(role: string, entry: VoiceCastEntry | undefined): Promise<void> {
  if (!entry) return
  try {
    const { provider } = await castBinding(role, entry)
    const { deleteDesignedVoice } = await import('../../../ai/speechVoiceDesign')
    await deleteDesignedVoice(
      provider,
      await apiKey(provider),
      entry.voiceId,
      AbortSignal.timeout(30_000)
    )
  } catch {
    // 留在百炼上，控制台里按 uebox 前缀能找到
  }
  const { promises: fs } = await import('node:fs')
  await fs.rm(entry.preview, { force: true }).catch(() => {})
}

const roleField = z
  .string()
  .min(1)
  .max(40)
  .describe('角色名，如「老铁匠」「主角」「旁白」。同一个角色以后配音时填同样的名字')

export function voiceDesignTools(): UnrealAgentTool[] {
  return [
    defineTool({
      name: 'design_voice',
      namespace: 'video.production',
      risk: 'mutating',
      concurrency: 'sequential',
      description:
        '按文字描述给游戏角色设计一个新音色，返回试听 WAV。只支持阿里云 Qwen-Audio 3.0 语音合成。' +
        '设计不收费，但还不能配音：对话里会自动挂出试听播放器，请用户听，然后调用 adopt_voice，' +
        '盒子会请用户确认。用户不满意就改描述再调一次，上一个试听会被替换。' +
        '先用 list_voices 看已有角色，别重复设计。',
      input: z.object({
        role: roleField,
        description: z
          .string()
          .min(1)
          .max(500)
          .describe(
            '中文或英文的声音描述，写年龄、性别、音色质感、语速、情绪底色、口音，' +
              '如「五十岁男性铁匠，嗓音低沉沙哑，语速偏慢，说话带着疲惫」'
          ),
        line: z
          .string()
          .min(15)
          .max(200)
          .describe('试听句，15 到 200 字，中文或英文。用这个角色在游戏里会说的一句台词')
      }),
      execute: async ({ role, description, line }, ctx) => {
        const { resolveSpeechBinding } = await import('../../../services/taskVideo/audio')
        const binding = await resolveSpeechBinding()
        const { supportsVoiceDesign, createDesignedVoice } = await import(
          '../../../ai/speechVoiceDesign'
        )
        if (!binding || !supportsVoiceDesign(binding.modelId))
          throw new Error(
            '音色设计目前只支持阿里云 Qwen-Audio 3.0 语音合成。' +
              '请到偏好设置 → 模型来源，把「语音合成」绑到它。'
          )
        const { normalizeRole, readVoiceCast, writeVoiceCast, previewPath } = await import(
          '../../../services/taskVideo/voiceCast'
        )
        const name = normalizeRole(role)
        const dir = await currentCastDir()
        ctx.report({ text: '正在设计音色' })
        const voice = await createDesignedVoice(
          binding.provider,
          await apiKey(binding.provider),
          binding.modelId,
          description,
          line,
          ctx.signal ?? AbortSignal.timeout(120_000)
        )
        const preview = previewPath(dir, name, voice.voiceId)
        const { promises: fs } = await import('node:fs')
        const { dirname } = await import('node:path')
        await fs.mkdir(dirname(preview), { recursive: true })
        await fs.writeFile(preview, voice.preview)
        const roles = await readVoiceCast(dir)
        const previous = roles[name]?.candidate
        roles[name] = {
          ...roles[name],
          candidate: {
            voiceId: voice.voiceId,
            providerId: binding.provider.id,
            modelId: binding.modelId,
            description,
            previewText: line,
            preview,
            createdAt: new Date().toISOString()
          }
        }
        await writeVoiceCast(dir, roles)
        await releaseVoice(name, previous)
        const result = {
          role: name,
          // 字段叫 path、带 title：对话界面按这个形状挂播放器（agentGeneratedMedia.ts）
          path: preview,
          title: `${name} · 试听`,
          status: '试听中，用户确认前不能配音',
          replaces_adopted: !!roles[name].adopted
        }
        return { text: JSON.stringify(result), details: result }
      }
    }),
    defineTool({
      name: 'adopt_voice',
      namespace: 'video.production',
      risk: 'mutating',
      // 每次都要人点：音色好不好听只有人能判断，批一次不代表下一个也行
      requiresExplicitApproval: true,
      concurrency: 'sequential',
      description:
        '把 design_voice 设计出的试听音色采用为该角色的正式音色，之后 generate_speech 填这个 role 就用它。' +
        '调用时盒子会弹卡片请用户确认，用户拒绝就按他的意见改描述重新设计。' +
        '角色原来已有音色的会被替换，旧音色从阿里云删除。',
      input: z.object({ role: roleField }),
      execute: async ({ role }, ctx) => {
        const { normalizeRole, readVoiceCast, writeVoiceCast } = await import(
          '../../../services/taskVideo/voiceCast'
        )
        const name = normalizeRole(role)
        const dir = await currentCastDir()
        const roles = await readVoiceCast(dir)
        const candidate = roles[name]?.candidate
        if (!candidate) throw new Error(`「${name}」没有待试听的音色，先用 design_voice 设计。`)
        const { provider } = await castBinding(name, candidate)
        const { queryDesignedVoice } = await import('../../../ai/speechVoiceDesign')
        const status = await queryDesignedVoice(
          provider,
          await apiKey(provider),
          candidate.voiceId,
          ctx.signal ?? AbortSignal.timeout(120_000)
        )
        if (status === 'UNDEPLOYED') {
          roles[name] = { ...roles[name], candidate: undefined }
          await writeVoiceCast(dir, roles)
          await releaseVoice(name, candidate)
          throw new Error(`「${name}」这个音色没通过阿里云审核，已删除。换个描述重新设计。`)
        }
        if (status !== 'OK')
          throw new Error(`「${name}」的音色还在阿里云处理中（${status}），稍等一会儿再采用。`)
        const previous = roles[name].adopted
        roles[name] = { adopted: candidate }
        await writeVoiceCast(dir, roles)
        await releaseVoice(name, previous)
        const result = { role: name, adopted: true, model: candidate.modelId }
        return { text: JSON.stringify(result), details: result }
      }
    }),
    defineTool({
      name: 'list_voices',
      namespace: 'video.production',
      risk: 'safe',
      concurrency: 'parallel',
      description:
        '列出当前工程的角色音色表：哪些角色有正式音色（generate_speech 的 role 可用）、哪些还在试听。',
      input: z.object({}),
      execute: async () => {
        const { readVoiceCast } = await import('../../../services/taskVideo/voiceCast')
        const roles = await readVoiceCast(await currentCastDir())
        const summary = (entry: VoiceCastEntry | undefined): object | undefined =>
          entry && { description: entry.description, model: entry.modelId, preview: entry.preview }
        const result = Object.entries(roles).map(([role, value]: [string, VoiceCastRole]) => ({
          role,
          adopted: summary(value.adopted),
          candidate: summary(value.candidate)
        }))
        return {
          text: result.length ? JSON.stringify(result) : '这个工程还没有设计过角色音色。',
          details: result
        }
      }
    })
  ]
}
