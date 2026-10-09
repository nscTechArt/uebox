import { describe, expect, it } from 'vitest'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'

/**
 * 已退役的 i18n key —— 改过名的 key 留下的旧路径。
 *
 * 改名有两条完成标准：
 * - **引用清零**由全仓搜索兜住：旧 key 的完整路径在 `src/` 下零命中。
 *   本文件按完整路径列出旧 key，不计入那次搜索 —— 它是下一条的断言本身。
 * - **定义清零**由这里断言：语言包是嵌套对象，旧 key 的完整路径不会作为
 *   字符串出现在里面，引用清零查不到旧定义；两侧都留着旧项时
 *   `criticalPathCoverage` 也不报。所以逐个取值，必须是 `undefined`。
 *
 * 以后再给 key 改名时，把旧路径加进来。取值方式同 `settingsCopy.test.ts` 的 `get`。
 */

function get(pack: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  }, pack)
}

const RETIRED_KEYS: string[] = [
  // 对话主体
  'assetLock.unknownSession',
  'assistant.sensitiveAction.allowForSession',
  'miniSensitiveConfirm.actions.allowSession',
  'assistant.topNav.clearSession',
  // 未命名对话：四个旧 key 合并为 assistant.chatFlow.unnamedChat
  'assistant.chat.unnamedSession',
  'assistant.chatFlow.unnamedSession',
  'assistant.agentMode.unnamedSession',
  'miniChatWindow.defaultSessionTitle',
  // 侧边问一句：命名空间 assistant.sideChat 改名为 assistant.sideQuestion
  'assistant.sideChat',
  // 语音通话：通话绑定显示改名为 assistantInputComposer.voice.boundCall
  'assistantInputComposer.voice.boundConversation',
  // 小窗：菜单 key 与命名空间 profile.miniChat 改名为 profile.miniWindow
  'profile.menu.miniChat',
  'profile.miniChat'
]

describe('已退役的 i18n key', () => {
  it.each(RETIRED_KEYS)('%s 在两份语言包里都不再有定义', (key) => {
    expect(get(zhCN, key), `zh-CN ${key}`).toBeUndefined()
    expect(get(enUS, key), `en-US ${key}`).toBeUndefined()
  })
})
