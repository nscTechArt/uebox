/**
 * 按 token 估算预算，而不是数字符。
 *
 * ## 为什么不能数字符
 *
 * 知识库这条线上原来有四个互不相干的字符上限（40000 / 50000 / 12000 / 8000），
 * 都是照着「中文约 1.5 字一个 token」拍出来的。这个换算只在中文成立：
 *
 * - 中文：一个汉字大约 1 个 token
 * - 英文 / 代码 / 路径：大约 3.5～4 个字符才 1 个 token
 *
 * 于是同一个「5 万字」上限，喂中文文档是 5 万 token（多数模型都塞不下），
 * 喂英文文档是 1.3 万 token（白白截掉了四分之三本来装得下的内容）。
 * UE 用户的资料恰好两种都有 —— 官方文档是英文，自己的笔记是中文。
 *
 * ## 估得准不准
 *
 * 不准，也不需要准。真正的分词要按具体模型的 tokenizer 走，那意味着为每家厂商
 * 带一份词表。这里要的只是「别把窗口撑爆、也别浪费四分之三」，量级对就够了，
 * 而且**一律往多了估**：估多了只是少送一点内容，估少了是厂商回 400、整个任务
 * 在半途硬断。两边代价不对称。
 */

/**
 * 认不出模型窗口时按这个算。
 *
 * 原来是 128k —— 照着「猜小只是少送材料，猜大是厂商回 400」定的。但那笔账在
 * 2026 年已经反过来了：现在还只有 128k 窗口的对话模型是少数，而**用户自己在
 * 设置里手填的模型**（自建端点、代理、目录里没有的新模型）恰恰都是新模型。
 * 按 128k 算的结果是：一条 30 万 token 的会话被过早压缩、知识库只送得进
 * 四分之一的材料，用户还看不出是哪儿限着 —— 界面上只显示「x / 128000」。
 *
 * 猜大的代价仍然存在（撞厂商上限是一次 400），但那一次是**看得见的报错**，
 * 而且这两个字段在「设置 → 模型 → 高级」里就能填，填了就以填的为准。
 */
export const DEFAULT_CONTEXT_WINDOW = 384_000

/** 认不出单次输出上限时按这个算。理由同上 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 128_000

/**
 * CJK 一个字算一个 token。
 *
 * 用 \u 转义写而不是直接贴字符：这个区间的头一个就是全角空格（U+3000），
 * 直接贴进源码是一个肉眼看不见、编辑器也不提示的「异形空白」，lint 会当场拦下。
 */
const CJK_PATTERN =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

/** 非 CJK 平均几个字符一个 token。英文散文约 4，代码和路径更碎，取 3.5 偏保守 */
const CHARS_PER_TOKEN_LATIN = 3.5

/**
 * 估一段文本大概多少 token。
 *
 * 逐字符分两类累加：CJK 记 1，其余按 {@link CHARS_PER_TOKEN_LATIN} 折算。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0

  let cjk = 0
  for (const char of text) {
    if (CJK_PATTERN.test(char)) cjk += 1
  }

  const latin = text.length - cjk
  return Math.ceil(cjk + latin / CHARS_PER_TOKEN_LATIN)
}

/** 一个模型的两个上限 */
export interface ModelLimits {
  /** 上下文窗口（token） */
  contextWindow: number
  /** 单次回复的最大输出 token */
  maxOutputTokens: number
}

/** 认不出模型时按这两个值算 */
export const FALLBACK_MODEL_LIMITS: ModelLimits = Object.freeze({
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS
})

/**
 * 这次调用能拿多少 token 装输入材料。
 *
 * 窗口要同时装下：系统提示词 + 材料 + 模型的回复。所以从窗口里先扣掉
 * 预留的输出，再扣一段提示词与格式开销的余量，剩下的才是材料能占的。
 *
 * @param limits 模型上限
 * @param plannedOutputTokens 这次打算让模型写多长（配方自己知道）
 */
export function inputTokenBudget(limits: ModelLimits, plannedOutputTokens: number): number {
  const output = Math.min(Math.max(0, plannedOutputTokens), limits.maxOutputTokens)
  // 系统提示词、消息包装、分词误差的余量。按窗口的一成留，最少留 1000
  const overhead = Math.max(1000, Math.floor(limits.contextWindow * 0.1))
  return Math.max(1000, limits.contextWindow - output - overhead)
}

/**
 * 把打算写多长钳进模型真正接受的范围。
 *
 * 原来知识库清洗那处写的是 `maxTokens: 内容字符数 * 1.2` —— 一个 5 万字的网页
 * 会发出 `max_tokens: 60000`，而多数厂商对这个字段有硬上限（4096 / 8192 / 16384），
 * 直接是一次 400。主进程也没有钳制，原样往下传。
 */
export function clampOutputTokens(wanted: number, limits: ModelLimits): number {
  return Math.max(1, Math.min(Math.ceil(wanted), limits.maxOutputTokens))
}
