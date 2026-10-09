/**
 * 工具报错的两件事：它值不值得学，以及把它压成能拿来比对的形状。
 *
 * ## 为什么先分「环境类」和「可学类」
 *
 * 2026-09-30 从一台开发机最近 400 个会话里抽过真实报错：7084 次工具调用、594 次失败，
 * 其中约 43% 是环境噪声 —— 用户按了停止、RPC 超时、编辑器没连、别的会话持锁、
 * 参数没过 schema、网络断了、生图配额用完。这些失败和「这一步该怎么做」无关，
 * 下一次同样的调用换个时间就成了。拿它们当经验，经验库第一天就是垃圾场 ——
 * 旧长期记忆下线的头号原因正是垃圾太多。
 *
 * 剩下的才是真知识：Python API 用错（`'Character' object has no attribute ...`，
 * 抽样里最多）、蓝图节点/引脚找不到、编译诊断、磁盘只读。
 *
 * ## 为什么归一化而不是原文比对
 *
 * 同一个错误每次带着不同的 RPC id、资产路径、行号、GUID。不抹掉的话，
 * 「这个错之前见过」永远是假。抹的是**会变的部分**，留的是**说明问题的部分** ——
 * `has no attribute 'is_hidden'` 里的 `is_hidden` 就是知识本身，不能抹。
 */

/**
 * 环境类报错的特征。命中任意一条就不学。
 *
 * 每一条都来自真实报错抽样，写宽不写窄：误判成环境类的代价是少学一条，
 * 误判成可学类的代价是经验库进一条垃圾。
 */
const ENVIRONMENTAL_PATTERNS: RegExp[] = [
  /请求超时|E_TIMEOUT|timed?[ -]?out/i,
  /没有可用的客户端连接|No Unreal Editor connection|not connected|连接已断开|编辑器已经关闭/i,
  // Python 发出去了但没拿到结果：执行了没有都不知道，谈不上知识
  /没有连接的虚幻引擎项目|未收到 Python 完成结果|Python 执行未确认|未确认执行结果/,
  /Operation aborted|aborted|已取消|用户按了停止/i,
  /另一条 AI (?:会话|对话)|正被.*修改中/,
  /Validation failed for tool/,
  /^Tool \S+ not found/,
  /net::ERR_|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|fetch failed/i,
  /quota|rate limit|HTTP 4(01|03|29)|HTTP 5\d\d/i,
  /已经失败 \d+ 次，这次调用被拦下了/,
  /拒绝|denied|未批准/i
]

export function isEnvironmentalError(text: string): boolean {
  return ENVIRONMENTAL_PATTERNS.some((pattern) => pattern.test(text))
}

/**
 * Python traceback 只留最后那行异常。
 *
 * 前面的 `File "<ua-script>", line 9` 每次都不一样，而且不说明问题；
 * `AttributeError: 'Character' object has no attribute 'is_hidden'` 才是。
 */
function lastPythonException(text: string): string | undefined {
  if (!text.includes('Traceback (most recent call last)')) return undefined
  // 裸的 `Exception:` 也要认：UE 的 Python 绑定常抛 `Exception: Material: Failed to find property ...`
  const matches = text.match(/\b(?:[A-Z][A-Za-z]*)?(?:Error|Exception|Warning): [^\n]*/g)
  return matches?.[matches.length - 1]
}

/**
 * 把报错压成能比对的形状：小写、会变的部分换成占位符、空白压成一个。
 *
 * 占位符用尖括号，是为了经验里的 `errorPattern` 也能写成同样的形状
 * （整理员拿到的就是归一化后的文本），比对时两边同一套规则。
 */
export function normalizeError(text: string): string {
  const core = lastPythonException(text) ?? text
  return (
    core
      // 工具自己加的前缀：「ue_save 失败：」
      .replace(/^[a-z0-9_]+ 失败[:：]\s*/i, '')
      .replace(/详情[:：]\s*\{\}/g, '')
      // GUID / UUID（RPC id、节点 GUID）
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
      .replace(/\b[0-9A-F]{32}\b/g, '<id>')
      // 磁盘路径先于资产路径：`I:/Game/...` 按资产路径抹会剩下一个 `i:`
      .replace(/[A-Za-z]:[\\/][^\s'"，,；;）)]+/g, '<path>')
      .replace(/\/(?:Game|Script|Engine|Plugins)\/[^\s'"，,；;：:）)]+/g, '<path>')
      // 数字（行号、下标、计数）
      .replace(/\d+(?:\.\d+)?/g, '<n>')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  )
}

/**
 * 报错的指纹：「同一个错又出现了」的判据。
 *
 * 取归一化文本的开头一段。不取全文，是因为批量工具会把几条失败拼在一起，
 * 顺序一变全文就不同，而第一条失败往往就是那一类问题。
 */
export function errorFingerprint(text: string): string {
  return normalizeError(text).slice(0, 120)
}
