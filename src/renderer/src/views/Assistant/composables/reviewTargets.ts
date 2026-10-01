import type { AgentReviewTarget } from '@core/shared/agentReview'

import { isEngineAssetPath, type ChangeGroup } from './changeSummary'

/**
 * 「本轮改动」清单 → 可以送去审查的目标。
 *
 * ## 为什么要过滤
 *
 * 清单里混着三种东西：引擎里的资产（`/Game/…`）、硬盘上的文件
 * （`D:/proj/说明.html`）、以及取不到目标的万能调用（`ue_run_python_script`
 * 归在工具名下）。审查问的是**引擎**「这个资产现在什么状态」，后两种它答不上来 ——
 * 送过去只会换回一句「资产不存在」，然后在界面上冒出一条假的错误。
 *
 * 失败的那些步骤也不在这里剔除：一个资产可能「加节点失败但材质本身建成了」，
 * 该不该报警由引擎的实际状态说了算，不由工具回了什么说了算。
 */
export function reviewTargetsFrom(groups: ChangeGroup[]): AgentReviewTarget[] {
  const targets: AgentReviewTarget[] = []

  for (const group of groups) {
    if (group.local) continue
    if (!isEngineAssetPath(group.target)) continue

    // enabled/disabled（插件启停）走不到这里 —— 插件名不是引擎资产路径，
    // 上面已经挡掉了；收窄只是让两边的类型对上
    const action: AgentReviewTarget['action'] =
      group.action === 'created' || group.action === 'deleted' ? group.action : 'modified'

    targets.push({
      path: group.target,
      action,
      ...(group.kind ? { kind: group.kind } : {})
    })
  }

  return targets
}

/**
 * 自动体检的资产上限。
 *
 * 体检要在编辑器里把每个资产 load 一遍，跑在游戏线程上 —— 用户这时多半正
 * 盯着编辑器看 AI 做了什么，卡一下就很显眼。超过这个数就不自动跑，留给
 * 用户自己点。
 */
export const AUTO_REVIEW_MAX_TARGETS = 20

/** 这一轮结束时要不要自动跑一次引擎体检。只看改了几个资产 */
export function shouldAutoReview(targets: AgentReviewTarget[]): boolean {
  return targets.length > 0 && targets.length <= AUTO_REVIEW_MAX_TARGETS
}
