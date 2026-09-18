import { ref, type Ref } from 'vue'
import { message } from '@renderer/utils/messageManager'
import { useI18n } from 'vue-i18n'

export type AIGCType = 'image' | '3d'

export interface PromptReferenceImage {
  url: string
  label?: string
}

export interface PromptOptimizeOptions {
  referenceImages?: PromptReferenceImage[]
}

type PromptContentPart =
  | {
      type: 'text'
      text: string
    }
  | {
      type: 'image_url'
      image_url: {
        url: string
        detail?: 'low' | 'high' | 'auto'
      }
    }

const MAX_REFERENCE_IMAGES = 4
const BASE_MAX_TOKENS_MAP: Record<AIGCType, number> = {
  image: 700,
  '3d': 500
}
const RETRY_MAX_TOKENS_MAP: Record<AIGCType, number> = {
  image: 1000,
  '3d': 700
}

const SYSTEM_PROMPTS_MAP: Record<'zh-CN' | 'en-US', Record<AIGCType, string>> = {
  'zh-CN': {
    image: `你是专业的 AI 图片提示词优化助手。请把用户输入或参考图整理成适合图像生成模型的高质量中文提示词。

要求：
1. 补强主体、动作、场景、风格、构图、光线、色彩与材质。
2. 如果有文字目标，以文字目标为主；如果没有文字目标，就根据参考图直接生成一条可用提示词。
3. 如果有参考图，可以吸收图中的外观、构图和视觉细节，但不要输出解释。

输出规则：
- 只输出优化后的中文提示词。
- 不要解释，不要 markdown。
- 通常控制在 120 字以内。`,

    '3d': `你是专业的 AI 3D 提示词优化助手。请把用户输入整理成适合 3D 模型生成的高质量中文提示词。

输出规则：
- 只输出优化后的中文提示词。
- 不要解释，不要 markdown。
- 保持简洁。`
  },
  'en-US': {
    image: `You are an expert prompt optimizer for AI image generation. Turn the user's text or reference images into a concise, production-ready prompt.

Rules:
1. Strengthen subject, action, scene, style, composition, lighting, color, and material.
2. If text is provided, keep text intent primary. If no text is provided, create a usable prompt directly from the images.
3. Use reference images for appearance and composition cues, but output only the final prompt.

Output only the optimized prompt. No explanation. No markdown.`,

    '3d': `You are an expert prompt optimizer for AI 3D generation. Rewrite the user's text into a concise, production-ready 3D prompt. Output only the prompt.`
  }
}

function normalizeReferenceImages(images?: PromptReferenceImage[]): PromptReferenceImage[] {
  if (!Array.isArray(images)) return []
  return images
    .map((item) => ({
      url: String(item?.url || '').trim(),
      label: String(item?.label || '').trim() || undefined
    }))
    .filter((item) => Boolean(item.url))
    .slice(0, MAX_REFERENCE_IMAGES)
}

function buildUserInstruction(
  lang: 'zh-CN' | 'en-US',
  prompt: string,
  referenceImages: PromptReferenceImage[]
): string {
  const normalizedPrompt = prompt.trim()
  const hasPrompt = normalizedPrompt.length > 0
  const hasImages = referenceImages.length > 0

  if (!hasImages) {
    return lang === 'zh-CN'
      ? `请优化以下提示词：${normalizedPrompt}`
      : `Please optimize the following prompt: ${normalizedPrompt}`
  }

  const labels = referenceImages
    .map((item, index) =>
      lang === 'zh-CN'
        ? `${index + 1}. ${item.label || '参考图'}`
        : `${index + 1}. ${item.label || 'reference image'}`
    )
    .join(lang === 'zh-CN' ? '；' : ', ')

  if (lang === 'zh-CN') {
    return [
      hasPrompt
        ? `请优化以下提示词，并结合我附带的参考图理解：${normalizedPrompt}`
        : '我没有输入文字提示词，请直接根据我附带的参考图，为我创建一条生成提示词。',
      '要求：',
      '1. 参考图用于补充主体外观、材质、色彩、构图或镜头线索。',
      hasPrompt
        ? '2. 输出以我的文字目标为主，不要只复述图片内容。'
        : '2. 如果没有文字目标，请把图片信息总结成一条可直接用于生成的提示词。',
      hasPrompt
        ? '3. 如果图片和文字冲突，优先保留文字意图，同时吸收可用视觉细节。'
        : '3. 让提示词尽量具体，包含主体、场景、风格和关键视觉特征。',
      `4. 附件顺序：${labels}`
    ].join('\n')
  }

  return [
    hasPrompt
      ? `Please optimize the following prompt and incorporate the attached reference images: ${normalizedPrompt}`
      : 'I did not provide a written prompt. Please create a generation prompt directly from the attached reference images.',
    'Requirements:',
    '1. Use the images to infer appearance, material, color, composition, or camera cues.',
    hasPrompt
      ? '2. Keep the output centered on my written goal rather than simply describing the images.'
      : '2. Turn the image information into a directly usable generation prompt instead of a plain description.',
    hasPrompt
      ? '3. If the images conflict with the text, prioritize the text while borrowing useful visual detail.'
      : '3. Make the prompt concrete, with subject, scene, style, and important visual traits.',
    `4. Attachment order: ${labels}`
  ].join('\n')
}

function buildUserContent(
  instruction: string,
  referenceImages: PromptReferenceImage[]
): string | PromptContentPart[] {
  if (referenceImages.length === 0) return instruction

  return [
    { type: 'text', text: instruction },
    ...referenceImages.map((item) => ({
      type: 'image_url' as const,
      image_url: {
        url: item.url,
        detail: 'auto' as const
      }
    }))
  ]
}

function sanitizeOptimizedPrompt(rawContent: string): string {
  return rawContent
    .trim()
    .replace(/^```[\w-]*\s*/u, '')
    .replace(/\s*```$/u, '')
    .replace(/^(["'“”`])+|(["'“”`])+$/gu, '')
    .trim()
}

function isTruncatedResponse(finishReason?: string): boolean {
  return finishReason === 'length'
}

export function usePromptOptimizer(): {
  isOptimizing: Ref<boolean>
  optimizePrompt: (
    type: AIGCType,
    userPrompt: string,
    options?: { referenceImages?: PromptReferenceImage[] }
  ) => Promise<string | null>
} {
  const { locale, t } = useI18n()
  const isOptimizing = ref(false)

  async function optimizePrompt(
    type: AIGCType,
    userPrompt: string,
    options?: PromptOptimizeOptions
  ): Promise<string | null> {
    const normalizedPrompt = String(userPrompt || '').trim()
    const referenceImages = normalizeReferenceImages(options?.referenceImages)

    if (!normalizedPrompt && referenceImages.length === 0) {
      message.warning(t('aigcImagePanel.toast.promptOrReferenceRequired'))
      return null
    }

    isOptimizing.value = true

    try {
      const currentLang =
        locale.value === 'zh-CN' || locale.value === 'en-US' ? locale.value : 'en-US'
      const systemPrompt = SYSTEM_PROMPTS_MAP[currentLang][type]
      const userInstruction = buildUserInstruction(currentLang, normalizedPrompt, referenceImages)
      const userContent = buildUserContent(userInstruction, referenceImages)
      // 含参考图时走 vision 角色，否则走轻量任务模型
      const hasReferenceImages = referenceImages.length > 0

      const requestOptimization = async (
        maxTokens: number,
        retryForLength = false
      ): Promise<{ content: string; finishReason?: string }> => {
        const response = await window.api.ai.chatCompletion({
          role: hasReferenceImages ? 'vision' : 'summary',
          maxTokens,
          temperature: 0.6,
          callType: 'prompt-optimize',
          messages: [
            {
              role: 'system',
              content: retryForLength
                ? `${systemPrompt}\n\n补充要求：如果上一轮输出不完整，请重新生成一条完整、可直接使用的最终提示词，一次性输出完整内容，不要续写残句。`
                : systemPrompt
            },
            { role: 'user', content: userContent }
          ]
        })

        if (!response.success) {
          throw new Error(response.error || '优化失败')
        }

        const responseData = (response.data || {}) as {
          content?: string
          finishReason?: string
        }

        return {
          content: sanitizeOptimizedPrompt(String(responseData.content || '')),
          finishReason: responseData.finishReason
        }
      }

      let optimizationResult = await requestOptimization(BASE_MAX_TOKENS_MAP[type])

      if (isTruncatedResponse(optimizationResult.finishReason)) {
        optimizationResult = await requestOptimization(RETRY_MAX_TOKENS_MAP[type], true)
      }

      const optimizedPrompt = optimizationResult.content

      if (!optimizedPrompt) {
        throw new Error('未获取到优化结果')
      }

      message.success(
        t(
          referenceImages.length > 0
            ? 'aigcImagePanel.toast.promptOptimizedWithReferences'
            : 'aigcImagePanel.toast.promptOptimized'
        )
      )
      return optimizedPrompt
    } catch (error) {
      console.error('[usePromptOptimizer] 优化失败:', error)
      message.error(error instanceof Error ? error.message : '优化失败，请重试')
      return null
    } finally {
      isOptimizing.value = false
    }
  }

  return {
    isOptimizing,
    optimizePrompt
  }
}
