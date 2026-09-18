/**
 * 「有未保存的改动，所以没执行」这条 409 的唯一翻译处。
 *
 * `ue_open_level` / `ue_new_level` / `ue_restart_editor` 三个工具共用 —— 之前
 * 是两份几乎一样的 `describeRefusal` 各自拼字符串，改一处漏一处。
 *
 * ## 为什么不能只说「先 ue_save，再重试」
 *
 * 那句话对**存得了**的包是对的，对 `/Temp/` 下没落过盘的包是死循环：
 * `ue_save` 存不了它们（存它需要用户先决定放哪儿），重试还是被同一份清单拦住。
 * 模型试完两轮之后唯一剩下的路是 `force=true`，而那是**把清单里的东西全丢**
 * —— 包括它刚做完、还没来得及存的资产。
 *
 * 实测里就是这么一路走到 force 的。所以这里按插件给的
 * `unsavable` 分两栏说，各给各的下一步。
 *
 * 顺带回答那份反馈里的另一半：`ue_list_unsaved` 报「没有未保存的改动」而这里
 * 被拦住，**不是两个工具打架**。它们回答的是两个问题（「哪些存得了」对
 * 「哪些会被丢掉」），判据在插件的 `UAL_SavablePackage.h` 里是刻意分开的。
 * 模型看不到那份注释，所以把这句话直接写进拒绝信息里。
 */

/** 插件在有未保存改动时回的 409，`details` 里带着清单 */
export interface UnsavedRefusalDetails {
  /** 全部会被丢掉的包（能存的在前）。老插件只有这一个字段 */
  unsaved?: string[]
  unsaved_count?: number
  /** 其中 `ue_save` **存不了**的那些。老插件没有这个字段 */
  unsavable?: string[]
  hint?: string
}

interface MaybeRefusal {
  __rpc?: { code?: number }
  code?: number
  details?: UnsavedRefusalDetails
}

/** 清单太长时只列前若干条 —— 全塞进去会挤爆上下文，而下一步动作是一样的 */
const MAX_LISTED = 10

function bullets(names: string[]): string {
  const shown = names.slice(0, MAX_LISTED).map((name) => `  ${name}`)
  if (names.length > MAX_LISTED) {
    shown.push(`  …另有 ${names.length - MAX_LISTED} 个`)
  }
  return shown.join('\n')
}

/**
 * 把插件的 409 翻译成一段能照着做的话；不是 409 就返回 null。
 *
 * @param raw     插件的原始响应
 * @param action  这次被拦住的动作，用来把第一句说具体（「打开关卡」「重启」）
 */
export function describeUnsavedRefusal(raw: unknown, action: string): string | null {
  const response = raw as MaybeRefusal
  const code = response?.__rpc?.code ?? response?.code
  if (code !== 409) return null

  const details = response.details ?? {}
  const all = details.unsaved ?? []
  const unsavable = details.unsavable ?? []
  const unsavableSet = new Set(unsavable)
  const savable = all.filter((name) => !unsavableSet.has(name))

  const head = `有 ${details.unsaved_count ?? '若干'} 处未保存的改动，${action}会把它们丢掉，所以没有执行。`

  const sections: string[] = []

  if (savable.length > 0) {
    sections.push(`能保存的（先调 ue_save）：\n${bullets(savable)}`)
  }

  if (unsavable.length > 0) {
    sections.push(
      `存不了的（ue_save 对它们无效，存完再试还是这一份清单）：\n${bullets(unsavable)}\n` +
        '这些包从没落过盘 —— 多半是一张还没保存过的新关卡和它的外部 Actor。\n' +
        '要留住它：先用 ue_save_level 给它一个路径（如 /Game/Maps/MyLevel）。\n' +
        '不要它：传 force=true —— 上面**所有**条目都会一起丢掉，无法撤销。\n' +
        '（ue_list_unsaved 列不出这几条，所以那边说「没有未保存的改动」' +
        '和这里被拦住并不矛盾 —— 以这份清单为准。）'
    )
  } else {
    // 老插件没有 unsavable 字段，或者确实全都存得了：退回原来那套话术
    if (savable.length === 0 && all.length > 0) {
      sections.push(`未保存：\n${bullets(all)}`)
    }
    sections.push(
      '正确做法：先调 ue_save 保存，再重试。\n' +
        '只有在用户明确说了「不要保存/丢弃」时才传 force=true —— 丢掉之后无法撤销。'
    )
  }

  return [head, ...sections].join('\n\n')
}
