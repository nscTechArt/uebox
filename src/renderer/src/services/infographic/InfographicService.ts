/**
 * 信息图生成服务
 * 调用生图模型将知识库内容转换为可视化信息图
 */

import type { InfographicState, InfographicConfig, InfographicResult } from './types'
import { DEFAULT_INFOGRAPHIC_CONFIG } from './types'
import type { SourceItem } from '@renderer/store/modules/notebookStore'
import type { ChatMessage } from '@renderer/store/modules/chatMessages'
import { collectAllContent, calculateTotalLength } from '../notebookContent/ContentCollector'
import { removeUrls } from '../notebookContent/textCleaner'
import { aiAPI } from '@renderer/api/ai'
import { clampOutputTokens, inputTokenBudget } from '@core/shared/tokenBudget'
import { packSourcesWithinBudget } from '@core/shared/notebookContext'
import { getModelLimits } from '@renderer/services/notebook/contextBudget'
import i18n, { getLocale } from '@renderer/i18n'
import { ref, type Ref } from 'vue'

/**
 * 根据当前语言设置生成信息图的系统提示词
 * 使用混合风格，AI 根据内容自动选择最合适的信息图类型
 * @param providerId 提供商配置标识，用于兼容豆包的视觉描述型 prompt
 * @returns 中文或英文版本的信息图生成提示词
 */
export function getDefaultInfographicPrompt(providerId?: string): string {
  const locale = getLocale()
  const isZh = locale.toLowerCase().startsWith('zh')

  // Doubao (volcengine) 使用视觉描述型prompt
  if (providerId === 'volcengine') {
    return `Professional infographic design, clean modern layout.
Title: "{title}" displayed prominently at top in bold sans-serif font.
Main content area with {content}
Visual style: Flat design, geometric shapes, clean lines, professional color palette with blue and white tones.
Icons and data visualization elements. High contrast, minimalist aesthetic.
8K resolution, vector graphics style, sharp edges, professional business presentation quality.`
  }

  // GPT Image 使用自然语言指令型prompt
  if (isZh) {
    return `
# 角色设定：
你是一位顶级科技公司的创意总监（如 Apple 或 Epic Games），擅长将复杂的技术概念转化为**极具美感、未来感且逻辑清晰**的视觉艺术作品。你的设计风格是“高端科技美学”。

# 核心任务：
基于【主题】和【内容摘要】，设计一张**视觉效果出众且信息结构严谨**的信息图。

# 风格自适应系统（关键步骤）：
你必须先分析【内容摘要】的属性，从以下风格中选择最匹配的一种进行绘制，**无需向我解释选择过程**，直接执行：

A. **如果是底层代码、系统架构或硬核技术：** 采用 [深色赛博朋克/玻璃拟态] 风格。强调发光线条、霓虹色、深邃背景。
B. **如果是商业逻辑、方法论或最终结论：** 采用 [浅色瑞士平面/极简主义] 风格。强调清晰排版、红黑白配色、大量留白。
C. **如果是创意构思、小说大纲或人文社科：** 采用 [复古工程蓝图/达芬奇手稿] 风格。强调纸质纹理、素描线条、墨水质感。
D. **如果是生活类、趣味科普或轻松话题：** 采用 [3D黏土/明亮波普] 风格。强调圆润模型、马卡龙配色、可爱氛围。
E. **如果是游戏、动画或影视：** 采用 [卡通拟人/梦幻卡通] 风格。强调鲜艳色彩、可爱角色、梦幻氛围。
F. **如果是金融、经济或商业：** 采用 [商务简约/现代简约] 风格。强调清晰排版、红黑白配色、大量留白。
G. **彩蛋：** 一个随机的彩蛋设计风格，没有任何边界限制。

# 设计与布局指南：
1.  **模块化布局（Bento Grid）：** 将信息组织成整齐、对齐的卡片或模块区域。像精密的仪表盘界面一样组织内容，既有秩序感又有设计张力。
2.  **视觉层级：**
    * **标题区：** 使用醒目的大号字体，可配合发光效果。
    * **核心数据/痛点：** 使用可视化图表（如环形图、进度条）或醒目的数字排版。
    * **流程/关系：** 使用发光的流线或简洁的科技感连接线来展示逻辑。
3.  **图标与图形：** 使用高质量的 3D 渲染风格图标或精致的线性图标，避免使用廉价的卡通插画。

# 内容处理原则：
* **不仅是排列文字：** 将【内容摘要】中的文字转化为视觉元素。例如，谈到“冲突”时，使用两个碰撞的抽象几何体；谈到“自动化”时，使用流动的光线穿过齿轮。
* **突出重点：** 提炼最核心的 3-5 个关键信息点，给予它们最大的视觉比重。

---
**主题：** {title}

**内容摘要：**
{content}

**生成指令：**
生成一张高分辨率、宽画幅的信息图。所有文字内容严格使用**简体中文**。确保画面既有酷炫的科技美感，又能清晰传达技术逻辑。
    `
  }

  return `Create a professional, visually stunning infographic based on the following content.

Design Guidelines:
1. AUTOMATICALLY choose the most appropriate visual style based on the content:
   - If the content contains statistics/numbers → Use data visualization (charts, percentages, metrics)
   - If the content describes processes/steps → Use flowchart or timeline style
   - If the content involves concept relationships → Use hierarchy diagrams or mind-map style
   - If the content is mixed → Combine appropriate visual elements

2. Visual Design Principles:
   - Use a modern, professional color palette with good contrast
   - Create clear visual hierarchy with distinct sections
   - Include icons and graphics to enhance understanding
   - Keep text concise and impactful - use bullet points and short phrases
   - Add a clear title at the top

3. Layout Requirements:
   - Organize information logically from top to bottom or left to right
   - Use consistent spacing and alignment
   - Ensure readability with appropriate font sizes
   - Balance text and visual elements

4. Content Focus:
   - Highlight the most important 3-5 key points
   - Use visual metaphors where appropriate
   - Create a cohesive narrative flow

Topic: {title}

Content Summary:
{content}

Generate a single, comprehensive infographic image that effectively communicates this information.`
}

/**
 * 将标题与内容摘要填入用户可编辑的 Prompt 模板。
 * 空白自定义模板会回退到当前服务商对应的默认 Prompt。
 */
export function composeInfographicPrompt(
  config: InfographicConfig,
  title: string,
  content: string
): string {
  const customPrompt = config.prompt?.trim()
  const template = customPrompt || getDefaultInfographicPrompt(config.providerId)
  return template.replaceAll('{title}', title).replaceAll('{content}', content)
}

/**
 * Stage 1: 将知识内容提炼为信息图设计Brief的Prompt
 * 输出 JSON 格式，包含标题和设计描述
 */
const SUMMARIZE_PROMPT = `你是一位专业的信息图设计师助手。请分析以下知识内容，提炼出一份简洁的信息图设计Brief。

请以 JSON 格式输出：
{
  "title": "核心主题（15字以内的标题）",
  "brief": "设计Brief内容（300-500字）"
}

Brief内容要求：
1. 关键要点：提炼3-5个最重要的信息点
2. 视觉风格建议：数据可视化/流程图/概念关系图
3. 重要数据：列出关键数字、百分比（如有）

直接输出 JSON，不要有任何前缀或解释。

知识内容：
{content}`

/** Stage 1 打算让模型写多长（Brief 是几百字的要点，不需要更多） */
const BRIEF_OUTPUT_TOKENS = 900

const INFOGRAPHIC_BRIEF_CACHE_STORAGE_KEY = 'infographic_brief_cache_v1'
const INFOGRAPHIC_BRIEF_CACHE_MAX_ENTRIES = 50

/*
  这里原来还有一个 24 小时的 TTL。缓存 key 里已经含内容 hash 了 —— 内容没变 key 就
  不变，再加 TTL 等于「一个字没改，隔天重新花一次钱生成同样的东西」。
  反过来真该失效的时候它不失效：换了模型、改了提示词，key 照样不变（只有手动改
  一个叫 VERSION 的常量才行）。现在把模型与提示词一起并进 key，TTL 就没必要了。
*/

interface InfographicBriefCacheEntry {
  title: string
  brief: string
  timestamp: number
}

const infographicBriefCache = new Map<string, InfographicBriefCacheEntry>()
let infographicBriefCacheLoaded = false

function hashString(str: string): string {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i)
  }
  return (hash >>> 0).toString(16)
}

function canUseLocalStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function persistInfographicBriefCache(): void {
  if (!canUseLocalStorage()) return

  const entries = Array.from(infographicBriefCache.entries())
    .sort(([, a], [, b]) => b.timestamp - a.timestamp)
    .slice(0, INFOGRAPHIC_BRIEF_CACHE_MAX_ENTRIES)

  try {
    window.localStorage.setItem(INFOGRAPHIC_BRIEF_CACHE_STORAGE_KEY, JSON.stringify(entries))
  } catch (error) {
    console.warn('[InfographicService] 持久化摘要缓存失败:', error)
  }
}

function ensureInfographicBriefCacheLoaded(): void {
  if (infographicBriefCacheLoaded || !canUseLocalStorage()) return
  infographicBriefCacheLoaded = true

  try {
    const raw = window.localStorage.getItem(INFOGRAPHIC_BRIEF_CACHE_STORAGE_KEY)
    if (!raw) return

    const parsed = JSON.parse(raw) as Array<[string, InfographicBriefCacheEntry]>
    // 不按时间过期：key 里含内容、模型与提示词，这三样没变就该复用
    const validEntries = parsed.filter(
      (entry): entry is [string, InfographicBriefCacheEntry] =>
        Array.isArray(entry) &&
        typeof entry[0] === 'string' &&
        typeof entry[1]?.title === 'string' &&
        typeof entry[1]?.brief === 'string' &&
        typeof entry[1]?.timestamp === 'number'
    )

    validEntries
      .sort(([, a], [, b]) => b.timestamp - a.timestamp)
      .slice(0, INFOGRAPHIC_BRIEF_CACHE_MAX_ENTRIES)
      .forEach(([key, value]) => {
        infographicBriefCache.set(key, value)
      })

    if (validEntries.length !== parsed.length) {
      persistInfographicBriefCache()
    }
  } catch (error) {
    console.warn('[InfographicService] 读取摘要缓存失败，已忽略损坏缓存:', error)
    window.localStorage.removeItem(INFOGRAPHIC_BRIEF_CACHE_STORAGE_KEY)
  }
}

/**
 * 缓存 key。
 *
 * 除了内容和知识库名，还要并进**这次用哪个模型**和**用的哪段提示词** —— 换了模型
 * 或者改了提示词，本来就该重算。上一版只在一个手写的 VERSION 常量里表达这件事，
 * 用户在设置里换个模型，拿到的还是旧模型生成的 Brief。
 */
function buildInfographicBriefCacheKey(
  content: string,
  notebookTitle: string,
  fingerprint: string
): string {
  const cacheFingerprint = [fingerprint, notebookTitle.trim(), content].join('\n')
  const hash = hashString(cacheFingerprint)
  return `${hash}_${cacheFingerprint.length}_${content.length}`
}

/**
 * 把 Stage 1 的回答解成 Brief。
 *
 * **解不出来就返回 null，不再拿原文前 1500 字冒充 Brief。** 上一版那样降级，
 * 生图模型收到的是一段照抄原文的长文本，画出来是一张糊满小字的图；用户看不出
 * 这是降级，只会以为「生图模型不行」。宁可这一步失败，也不要一张假的成品。
 */
function normalizeSummaryResponse(
  rawContent: string,
  notebookTitle: string
): { title: string; brief: string; cacheable: boolean } | null {
  const trimmedContent = rawContent.trim()
  if (!trimmedContent) return null

  // 不是每家都支持 response_format，不支持的那几家会照着提示词返回，
  // 外面常常裹一层 ```json 代码块 —— 裸 JSON.parse 解不出来
  const fenced = trimmedContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const body = (fenced ? fenced[1] : trimmedContent).trim()

  try {
    const parsed = JSON.parse(body) as {
      title?: unknown
      brief?: unknown
    }

    const title =
      typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : notebookTitle
    const brief = typeof parsed.brief === 'string' ? parsed.brief.trim() : ''

    return brief ? { title, brief, cacheable: true } : null
  } catch {
    /*
      还是不是 JSON，但模型确实写了东西 —— 这一次当纯文本 Brief 用，但**不缓存**。

      缓存它的后果是：那段带围栏的原始 JSON（或者模型的任何一句胡话）成了这个
      知识库的永久 Brief，TTL 已经删掉了，唯一的出路是手改 localStorage。
    */
    return { title: notebookTitle, brief: body, cacheable: false }
  }
}

function getCachedInfographicBrief(cacheKey: string): { title: string; brief: string } | null {
  ensureInfographicBriefCacheLoaded()

  const entry = infographicBriefCache.get(cacheKey)
  if (!entry) {
    return null
  }

  // 不按时间过期：key 里含内容、模型与提示词，这三样没变就该复用。
  // timestamp 只用来决定超出条数上限时先淘汰谁。
  entry.timestamp = Date.now()
  infographicBriefCache.set(cacheKey, entry)
  persistInfographicBriefCache()
  console.log(`[InfographicService] Stage 1 摘要缓存命中: ${cacheKey.slice(0, 20)}...`)

  return {
    title: entry.title,
    brief: entry.brief
  }
}

function setCachedInfographicBrief(
  cacheKey: string,
  value: { title: string; brief: string }
): void {
  ensureInfographicBriefCacheLoaded()

  infographicBriefCache.set(cacheKey, {
    title: value.title,
    brief: value.brief,
    timestamp: Date.now()
  })

  while (infographicBriefCache.size > INFOGRAPHIC_BRIEF_CACHE_MAX_ENTRIES) {
    const oldestEntry = Array.from(infographicBriefCache.entries()).sort(
      ([, a], [, b]) => a.timestamp - b.timestamp
    )[0]
    if (!oldestEntry) break
    infographicBriefCache.delete(oldestEntry[0])
  }

  persistInfographicBriefCache()
}

/**
 * 信息图生成服务类
 */
export class InfographicService {
  /** 响应式状态 */
  public state: Ref<InfographicState>

  /** 配置 */
  private config: InfographicConfig

  constructor(config: InfographicConfig = DEFAULT_INFOGRAPHIC_CONFIG) {
    this.config = config
    this.state = ref({
      status: 'idle',
      progress: 0,
      message: ''
    })
  }

  /**
   * 更新状态
   * @param updates 部分状态更新
   */
  private updateState(updates: Partial<InfographicState>): void {
    this.state.value = { ...this.state.value, ...updates }
  }

  /**
   * Stage 1：把知识内容提炼成信息图的设计 Brief。
   *
   * 提炼不出来就返回 null —— 上一版会拿原文前 1500 字冒充 Brief，生图模型照着
   * 画出一张糊满小字的图，用户还以为是生图模型不行。
   *
   * 走用户配的「轻量任务」模型，不绑任何厂商：上一版这里写着 `provider: 'qwen'`，
   * 那个参数其实早就被 `aiAPI.chat` 丢掉了（它只转发 role），留着只会误导人。
   * 同样被丢掉的还有 `timeout` 和 `extra_body` —— 一并删掉，别写不生效的参数。
   */
  private async summarizeForInfographic(
    content: string,
    notebookTitle: string
  ): Promise<{ title: string; brief: string; cacheable: boolean } | null> {
    const prompt = SUMMARIZE_PROMPT.replace('{content}', content)

    try {
      const response = await aiAPI.chat({
        messages: [
          {
            role: 'system',
            content: `你是专业的信息图设计师助手，正在为"${notebookTitle}"设计信息图。请返回 JSON 格式。`
          },
          { role: 'user', content: prompt }
        ],
        responseFormat: { type: 'json_object' },
        level: 'fast',
        maxTokens: clampOutputTokens(BRIEF_OUTPUT_TOKENS, await getModelLimits('summary')),
        callType: 'notebook-infographic'
      })

      const rawContent = response.content || ''
      console.log(`[InfographicService] Stage 1 响应长度: ${rawContent.length} 字符`)
      return normalizeSummaryResponse(rawContent, notebookTitle)
    } catch (error) {
      console.error('[InfographicService] Stage 1 摘要失败:', error)
      return null
    }
  }

  /**
   * 生成信息图
   * @param sources 知识库来源
   * @param messages 聊天消息
   * @param notebookTitle 知识库标题
   * @returns 生成的结果对象（包含标题和图片），失败返回 null
   */
  async generate(
    sources: SourceItem[],
    messages: ChatMessage[],
    notebookTitle: string
  ): Promise<InfographicResult | null> {
    try {
      // Step 1: 收集内容
      this.updateState({
        status: 'collecting',
        progress: 10,
        message: '正在收集知识库内容...'
      })

      /*
        送多少材料按模型窗口算，但要按**真正接这一步的那个模型**算。

        Stage 1 发的是 level:'fast'，映射到「轻量任务」角色；而 resolveNotebookCharBudget()
        取的是「对话」角色的窗口。用户完全可能对话绑 1M 大模型、轻量任务绑 32k 小模型
        —— 那正是这个档位存在的意义 —— 按对话的窗口装料，发给小模型必然 400。
      */
      const summaryLimits = await getModelLimits('summary')
      const charBudget = inputTokenBudget(summaryLimits, BRIEF_OUTPUT_TOKENS)
      const allContent = collectAllContent(sources, messages)
      const totalLength = calculateTotalLength(allContent)
      console.log(
        `[InfographicService] 收集到 ${allContent.length} 个内容项，共 ${totalLength} 字符`
      )

      if (allContent.length === 0) {
        this.updateState({
          status: 'failed',
          progress: 0,
          message: '没有可用的内容',
          error: '知识库为空，请先添加一些来源或进行对话'
        })
        return null
      }

      // Step 2: 过滤URL并合并内容
      this.updateState({
        status: 'generating',
        progress: 30,
        message: '正在分析内容要点...'
      })

      /*
        使用公共工具函数过滤URL链接，避免触发网页搜索。

        合并之后**必须再按总预算装一次箱**：collectAllContent 只保证每一条不超预算，
        十条各三万字加起来照样能撑爆窗口。上一版这里靠一个写死的 12000 字上限兜着，
        那个常量删掉之后就什么都不剩了。
      */
      const blocks = allContent.map((item) => {
        const cleanContent = removeUrls(item.content)
        return {
          title: item.title,
          content: item.title ? `【${item.title}】\n${cleanContent}` : cleanContent
        }
      })
      const { included, dropped } = packSourcesWithinBudget(blocks, charBudget)
      if (dropped.length > 0) {
        console.warn(
          `[InfographicService] ${dropped.length} 段内容超出本次预算未送入：` +
            dropped.map((item) => item.title || '未命名').join('、')
        )
      }
      /*
        一段都没装进去就停在这里，别往下走。

        装箱是「装不下的整条丢掉」，所以每段都比预算大时 `included` 是空的，
        `rawText` 就是空串 —— summarizeForInfographic 拿一个空串照样能编出标题和要点，
        然后真的去调生图模型：用户花了一次生图的钱，拿回一张跟他的资料毫无关系的图。
      */
      if (included.length === 0) {
        this.updateState({
          status: 'failed',
          progress: 0,
          message: i18n.global.t('notebook.studio.sourcesOverBudgetShort'),
          error: i18n.global.t('notebook.studio.sourcesOverBudget', { budget: charBudget })
        })
        return null
      }

      const rawText = included.map((item) => item.content).join('\n\n')
      console.log(`[InfographicService] 原始内容长度: ${rawText.length} 字符`)

      // Step 3: 优先复用相同已应用来源和对话内容的摘要缓存
      this.updateState({
        progress: 40,
        message: '正在检查摘要缓存...'
      })

      /*
        指纹里带上这次**具体是哪个模型**，而不只是它的两个数字上限。

        上一版只放了 contextWindow:maxOutputTokens —— 两个都不在内置目录里的
        自定义端点会一起回落到同一份缺省上限，指纹完全相同，换了模型照样命中
        旧缓存，而 TTL 又已经删掉了，于是那份 Brief 被永久复用。
      */
      const briefFingerprint = [
        summaryLimits.providerId ?? '',
        summaryLimits.modelId ?? '',
        summaryLimits.contextWindow,
        summaryLimits.maxOutputTokens,
        hashString(SUMMARIZE_PROMPT)
      ].join(':')
      const briefCacheKey = buildInfographicBriefCacheKey(rawText, notebookTitle, briefFingerprint)
      let summarizedResult = getCachedInfographicBrief(briefCacheKey)

      if (!summarizedResult) {
        this.updateState({
          progress: 45,
          message: '正在提炼关键信息...'
        })
        const summaryResult = await this.summarizeForInfographic(rawText, notebookTitle)

        // 提炼失败就到此为止。上一版会拿原文前 1500 字冒充 Brief 接着画，
        // 画出来是一张糊满小字的图，用户还以为是生图模型不行
        if (!summaryResult) {
          this.updateState({
            status: 'failed',
            progress: 0,
            message: i18n.global.t('notebook.studio.briefFailedShort'),
            error: i18n.global.t('notebook.studio.briefFailed')
          })
          return null
        }

        summarizedResult = { title: summaryResult.title, brief: summaryResult.brief }
        // 解析出来的才存；模型回了一段没法解析的东西时这次先用着，但别记住它
        if (summaryResult.cacheable) setCachedInfographicBrief(briefCacheKey, summarizedResult)
      } else {
        this.updateState({
          progress: 45,
          message: '已复用摘要缓存，正在整理设计要点...'
        })
      }

      const { title: extractedTitle, brief: designBrief } = summarizedResult
      console.log(
        `[InfographicService] 设计Brief长度: ${designBrief.length} 字符, 标题: ${extractedTitle}`
      )

      // Step 4: 构建最终 Prompt
      this.updateState({
        progress: 50,
        message: '正在设计信息图布局...'
      })

      const prompt = composeInfographicPrompt(this.config, extractedTitle, designBrief)

      // Step 5: 调用图像生成 API
      this.updateState({
        progress: 60,
        message: '正在生成信息图请稍等...'
      })

      console.log('[InfographicService] 调用图像生成 API...')

      const response = await aiAPI.generateImage({
        prompt: prompt,
        imageSize: this.config.imageSize,
        aspectRatio: this.config.aspectRatio,
        localProviderId: this.config.providerId,
        localModelId: this.config.modelId
      })

      // Step 6: 处理响应
      this.updateState({
        progress: 90,
        message: '正在处理生成结果...'
      })

      if (!response.ok || !response.images || response.images.length === 0) {
        throw new Error('图像生成失败：未返回有效图片')
      }

      // 优先使用 base64，其次使用 URL
      const imageData = response.images[0].base64
        ? `data:image/png;base64,${response.images[0].base64}`
        : response.images[0].url

      if (!imageData) {
        throw new Error('图像生成失败：未返回图片数据')
      }

      console.log('[InfographicService] 信息图生成成功')

      this.updateState({
        status: 'completed',
        progress: 100,
        message: '信息图生成完成',
        imageData
      })

      return { title: extractedTitle, imageUrl: imageData }
    } catch (error) {
      console.error('[InfographicService] 生成失败:', error)
      this.updateState({
        status: 'failed',
        progress: 0,
        message: '生成失败',
        error: error instanceof Error ? error.message : '未知错误'
      })
      return null
    }
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.state.value = {
      status: 'idle',
      progress: 0,
      message: ''
    }
  }
}

/**
 * 创建信息图服务实例
 * @param config 可选配置
 * @returns InfographicService 实例
 */
export function createInfographicService(config?: InfographicConfig): InfographicService {
  return new InfographicService(config)
}
