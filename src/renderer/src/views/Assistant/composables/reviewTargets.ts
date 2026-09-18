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
