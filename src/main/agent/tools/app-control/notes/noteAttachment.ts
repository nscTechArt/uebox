/**
 * Agent 写笔记时的「挂载」规则。
 *
 * 为什么非要挂：`create_note` 一度被两个内置 skill 明令禁用
 * （deep-research / knowledge-base-and-projects），理由是 agent 建出来的笔记
 * 没有任何用户能打开的入口 —— 它躺在库里，用户一辈子看不见，模型却以为
 * 自己「保存好了」。
 *
 * 资产和文件夹的「详细说明」给笔记补上了入口，所以规则是：agent 可以写笔记，
 * 但必须说清这篇挂在哪个资产或哪个文件夹上。没有归属的笔记就是旧问题本身。
 */

/** 挂载目标：资产或文件夹，二选一 */
export type NoteAttachTarget = { kind: 'asset'; key: string } | { kind: 'folder'; key: string }

export type ResolveTargetResult =
  | { ok: true; target: NoteAttachTarget }
  | { ok: false; error: string }

/**
 * 从工具入参里解出挂载目标。
 *
 * 两个都给或都不给都算错 —— 让模型自己说清楚，比我们替它挑一个强。
 * 错误话术直接面向模型，所以要写清「下一步该怎么做」而不只是「你错了」。
 */
export function resolveAttachTarget(params: {
  assetKey?: string
  folderKey?: string
}): ResolveTargetResult {
  const assetKey = params.assetKey?.trim()
  const folderKey = params.folderKey?.trim()

  if (assetKey && folderKey) {
    return {
      ok: false,
      error:
        'assetKey 和 folderKey 只能给一个：一篇笔记要么是某个资产的说明，要么是某个文件夹的说明。'
    }
  }

  if (assetKey) return { ok: true, target: { kind: 'asset', key: assetKey } }
  if (folderKey) return { ok: true, target: { kind: 'folder', key: folderKey } }

  return {
    ok: false,
    error:
      '必须指明这篇笔记挂在哪里：给 assetKey（资产的说明）或 folderKey（文件夹的说明）。' +
      '没有挂载的笔记在界面上没有入口，用户永远看不到它 —— ' +
      '先用 search_assets 找到目标，再带着它的 key 调一次。'
  }
}

/**
 * 目标已经有说明书时的话术。
 *
 * 不直接覆盖：用户可能写了很多内容，模型「建一篇新的」时不该把它冲掉。
 * 告诉它已有的那篇 id，让它自己决定是读一遍还是改。
 */
export function alreadyAttachedError(target: NoteAttachTarget, existingNoteId: number): string {
  const what = target.kind === 'asset' ? '这个资产' : '这个文件夹'
  return (
    `${what}已经有一篇说明了（笔记 id = ${existingNoteId}）。` +
    `先用 get_note 看看里面写了什么；要补充就用 update_note 改那一篇，不要新建。`
  )
}

/** 目标不存在时的话术 */
export function targetNotFoundError(target: NoteAttachTarget): string {
  return target.kind === 'asset'
    ? `找不到 assetKey = ${target.key} 的资产。先用 search_assets 确认它存在。`
    : `找不到 folderKey = ${target.key} 的文件夹。`
}
