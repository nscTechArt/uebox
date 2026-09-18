/**
 * 来源清洗与摘要服务
 *
 * 两件不同的事，别混：
 * - {@link cleanWebContent} 做的是**去噪清洗**：删广告导航、保留全文，一个字都不省。
 *   只在导入网页时跑一次，结果作为正文，原文另存（见 `raw_content` 列）。
 * - {@link condenseSource} 做的才是**摘要**：把正文压成几百到一千多字，
 *   给「只给摘要」那一档用。按需生成，用户不选摘要就不花这笔钱。
 *
 * 两条路都**不绑任何厂商**，走用户在设置里配的模型。
 */

import { aiAPI } from '@renderer/api/ai'
import { MIN_USABLE_SUMMARY_CHARS } from '@core/shared/notebookContext'
import { clampOutputTokens, estimateTokens, inputTokenBudget } from '@core/shared/tokenBudget'
import i18n from '@renderer/i18n'
import { getModelLimits } from '@renderer/services/notebook/contextBudget'

/**
 * YouTube URL 检测模式
 */
const YOUTUBE_PATTERNS = [/youtube\.com/i, /youtu\.be/i, /m\.youtube\.com/i]

/**
 * 检查 URL 是否为 YouTube 链接
 * @param url 来源 URL
 * @returns 是否为 YouTube 链接
 */
export function isYouTubeUrl(url: string | null | undefined): boolean {
  if (!url) return false
  return YOUTUBE_PATTERNS.some((pattern) => pattern.test(url))
}

/** 短于这个长度的网页不值得清洗：噪音本来就没几行，白花一次调用 */
const MIN_CLEANABLE_CHARS = 500

/**
 * 这条抓回来的网页要不要清洗。
 *
 * 上一版这里叫 `shouldSummarize`，按来源类型分派 —— 但唯一的调用点传的是**字面量
 * `'link'`**，而且那行本来就在 `type === 'link'` 的分支里，所以类型分派从没生效过。
 * 顺带一个后果：微信公众号（`wechat` / `mp`）明明就是网页，因为类型不叫 `link`
 * 从来没被清洗过 —— 而公众号页面恰恰是噪音最多的一类。
 *
 * 现在只问三件真正相关的事：内容够不够长、是不是 YouTube（那是字幕，没有页面噪音）、
 * 有没有内容。至于它是 `link` 还是 `wechat`，调用方自己知道，不必再绕一层。
 */
export function shouldCleanWebContent(content: string, sourceUrl?: string | null): boolean {
  if (content.trim().length < MIN_CLEANABLE_CHARS) return false
  if (isYouTubeUrl(sourceUrl)) return false
  return true
}

/**
 * 去噪清洗提示词
 * 只删除噪音，保留原文结构
 */
const CLEAN_PROMPT = `【任务目标】
对以下网页内容进行"去噪清洗"，**严禁重组或改写**内容结构。

【执行要求】
1. **去噪**：删除广告、导航链接、页脚、Cookie提示、二维码、App下载提示、无意义的客套话和正文无关的内容。
2. **保留**：完整保留原文的段落结构、逻辑顺序、具体数据和事例。
3. **规范**：修正错别字，统一标点符号。
4. **禁止**：不要写成摘要，不要合并段落，不要改变原意。

直接输出清洗后的内容，不要有任何前缀或解释。

【待处理网页内容】：
`

const CLEAN_SYSTEM = `你是一个专业的内容清洗专家。
你的任务是清理网页中的噪音（广告、导航、页脚等），保留有价值的正文内容。

关键原则：
1. **保留原文结构**：不要重新组织或改写内容，保持原文的段落顺序。
2. **保留所有实质信息**：保留所有具体数据、日期、人名、专有名词。
3. **保留有意义的链接和图片**：保留与正文内容相关的图片链接和参考链接，只删除广告链接和导航链接。
4. **只删除噪音**：只删除明显的广告、导航菜单、页脚链接、App推广、二维码、Cookie提示等无关内容。
5. **不要总结**：这不是摘要任务，不要压缩或概括内容。

直接输出清洗后的内容。`

/**
 * 一次清洗的结果。
 *
 * 上一版这个函数不管成功失败都 `return content` —— 调用方拿到的东西一模一样，
 * 于是「清洗成功」「模型拒了」「网络断了」三件完全不同的事对用户长得一样，
 * 他只能看到「清洗好像没生效」，不知道为什么。现在把它们分开。
 */
export type CleanOutcome =
  /** 清洗成功，`content` 是清洗后的正文 */
  | { ok: true; content: string }
  /** 没清成。`reason` 是能给用户看的一句话，正文照原样用 */
  | { ok: false; reason: string }

/**
 * 对抓回来的网页做去噪清洗。
 *
 * **不走写死的模型。** 上一版这里写着 `provider: 'qwen', model: 'qwen-flash'` ——
 * 那两个参数其实早就被 `aiAPI.chat` 丢掉了（它只转发 role），但留着会让人以为
 * 这条路绑死在某一家。社区版不绑任何厂商：走用户在设置里配的「轻量任务」模型。
 */
export async function cleanWebContent(content: string): Promise<CleanOutcome> {
  try {
    const limits = await getModelLimits('summary')

    /*
      清洗是「照抄一遍去掉噪音」，输出长度必然和输入同量级。所以先看这个模型
      一次能不能写得下 —— 写不下就**别开始**。

      不查的话会更糟：`maxTokens` 被钳到模型上限，模型写到一半就停，返回的是
      一段完整开头 + 突然截断，`text.trim()` 非空于是被当成清洗成功，写进 content
      覆盖掉原文，只有那一小段进了索引。厂商回 400 至少还能保住完整原文。
    */
    const neededOutput = Math.ceil(estimateTokens(content) * 1.2)
    if (neededOutput > limits.maxOutputTokens) {
      return {
        ok: false,
        reason: i18n.global.t('notebook.source.cleanTooLong', {
          limit: limits.maxOutputTokens
        })
      }
    }

    const text = await aiAPI.chatText({
      messages: [
        { role: 'system', content: CLEAN_SYSTEM },
        { role: 'user', content: CLEAN_PROMPT + content }
      ],
      // 清洗是「照抄一遍去掉噪音」，用轻量档就够，别占用户的贵模型
      level: 'fast',
      callType: 'notebook-source-clean',
      // 上面已经确认写得下，这里只是把它钳进合法范围
      maxTokens: clampOutputTokens(neededOutput, limits)
    })

    const trimmed = text.trim()
    if (!trimmed) {
      return { ok: false, reason: i18n.global.t('notebook.source.cleanEmpty') }
    }

    /*
      去噪最多删掉噪音，不该把正文砍掉一多半。短得离谱说明模型没写完就停了
      （输出被截断，或者它自作主张写成了摘要）—— 那份东西不能拿去覆盖原文。
    */
    if (trimmed.length < content.length * 0.4) {
      return {
        ok: false,
        reason: i18n.global.t('notebook.source.cleanTruncated', {
          before: content.length,
          after: trimmed.length
        })
      }
    }

    console.log(
      `[SourceSummarizer] 清洗完成，原文 ${content.length} 字 -> 清洗后 ${trimmed.length} 字`
    )
    return { ok: true, content: trimmed }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error('[SourceSummarizer] 清洗失败:', error)
    return { ok: false, reason }
  }
}

/** 摘要目标长度上限。四千字的摘要就不叫摘要了 */
const CONDENSE_OUTPUT_MAX_TOKENS = 1200

const CONDENSE_SYSTEM = `你是一位资料摘要专家。把用户给的材料压成一份**密度极高**的摘要。

## 输出格式
只输出 markdown 正文，不要代码块包裹、不要开场白：
- 开头一段话说清这份材料讲什么（100 字以内）
- 之后用无序列表列出关键信息，每条一句话

## 要求
1. 总长控制在 600-1200 字
2. **保留具体信息**：数字、版本号、参数名、类名、路径、专有名词一律照抄原文，不要改写成「某个参数」
3. 材料里没有的不要补
4. 不要写「本文介绍了」「综上所述」这类废话`

/**
 * 把一条来源压成摘要，给「只给摘要」那一档用。
 *
 * 压不动就返回 null（不是抛异常）：摘要生成失败是常事（模型没配好、余额不够），
 * 而它不该把用户切档位这个动作变成一次报错弹窗 —— 调用方收到 null 就把状态
 * 记成 failed，界面上那一条显示「摘要没生成，暂时按正文开头送」。
 */
export async function condenseSource(
  content: string,
  options: { signal?: AbortSignal } = {}
): Promise<string | null> {
  const source = content.trim()
  // 本来就不长，压了也省不下什么，还白花一次调用
  if (source.length < 2000) return null

  try {
    const limits = await getModelLimits('summary')
    // 读多少正文按模型窗口算，不是写死的 6 万字：配了大窗口的模型就该能一次读完，
    // 配了小模型也不至于撑爆
    const inputBudget = inputTokenBudget(limits, CONDENSE_OUTPUT_MAX_TOKENS)

    const text = await aiAPI.chatText({
      messages: [
        { role: 'system', content: CONDENSE_SYSTEM },
        { role: 'user', content: source.slice(0, inputBudget) }
      ],
      level: 'fast',
      maxTokens: clampOutputTokens(CONDENSE_OUTPUT_MAX_TOKENS, limits),
      callType: 'notebook-source-summary',
      ...(options.signal ? { signal: options.signal } : {})
    })

    const trimmed = text
      .replace(/^```(?:markdown)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim()

    // 太短说明模型只回了一句寒暄，当没生成
    if (trimmed.length < MIN_USABLE_SUMMARY_CHARS) {
      console.warn('[SourceSummarizer] 摘要太短，按未生成处理')
      return null
    }

    // 压完比原文还长（模型自由发挥了），留着只会更费钱
    if (trimmed.length >= source.length) {
      console.warn('[SourceSummarizer] 摘要没有比原文短，丢弃')
      return null
    }

    return trimmed
  } catch (error) {
    console.error('[SourceSummarizer] 摘要生成失败:', error)
    return null
  }
}
