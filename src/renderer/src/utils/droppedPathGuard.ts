/**
 * 拖拽入口的路径体检（渲染层这一半）。
 *
 * 判定规则在 `src/shared/droppedPath.ts`，但「系统临时目录在哪」只有主进程知道，
 * 所以这里只负责问一次主进程，再把坏路径归成两类，让界面能说一句人话 ——
 * 而不是让每条坏路径各自在底层炸一次 ENOENT。
 */
import type { DroppedPathVerdict } from '@core/shared/droppedPath'

export type RejectedDropReason = Exclude<DroppedPathVerdict, 'ok'>

export interface DroppedPathFilterResult {
  /** 确认是磁盘上真实存在位置的路径，只有这些能往下走 */
  accepted: string[]
  /** 被挡下的，按原因分组 —— 界面按原因给提示，不逐条刷屏 */
  rejected: Record<RejectedDropReason, string[]>
}

function emptyRejected(): Record<RejectedDropReason, string[]> {
  return { 'not-absolute': [], 'archive-temp': [] }
}

/**
 * 体检一批拖进来的路径。
 *
 * 主进程这一跳失败时**全部放行**：路径体检是防呆，不是权限门。宁可让原来的
 * 报错照旧出现，也不能因为一次 IPC 抖动就把用户正常的拖拽全挡了。
 */
export async function filterDroppedPaths(filePaths: string[]): Promise<DroppedPathFilterResult> {
  const accepted: string[] = []
  const rejected = emptyRejected()

  if (filePaths.length === 0) return { accepted, rejected }

  let verdicts: Array<{ path: string; verdict: DroppedPathVerdict }>
  try {
    verdicts = await window.api.classifyDroppedPaths(filePaths)
  } catch (error) {
    console.warn('[droppedPathGuard] 路径体检失败，按原样放行:', error)
    return { accepted: [...filePaths], rejected }
  }

  for (const item of verdicts) {
    if (item.verdict === 'ok') {
      accepted.push(item.path)
      continue
    }
    rejected[item.verdict].push(item.path)
  }

  return { accepted, rejected }
}

/** 有没有东西被挡下 —— 界面据此决定要不要弹提示 */
export function hasRejectedDrops(rejected: Record<RejectedDropReason, string[]>): boolean {
  return rejected['not-absolute'].length > 0 || rejected['archive-temp'].length > 0
}

/**
 * 把挡下的路径翻成要给用户看的话，按原因合并成最多两条。
 *
 * 返回 i18n key 而不是成品文案，是因为这段逻辑两个拖拽入口都要用，
 * 而 `t` 只在组件里拿得到。
 */
export function describeRejectedDrops(
  rejected: Record<RejectedDropReason, string[]>
): Array<{ key: string; params: { count: number } }> {
  const messages: Array<{ key: string; params: { count: number } }> = []

  if (rejected['not-absolute'].length > 0) {
    messages.push({
      key: 'dragImportGuard.fromArchive',
      params: { count: rejected['not-absolute'].length }
    })
  }
  if (rejected['archive-temp'].length > 0) {
    messages.push({
      key: 'dragImportGuard.fromExtractorTemp',
      params: { count: rejected['archive-temp'].length }
    })
  }

  return messages
}
