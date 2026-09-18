import { ref } from 'vue'

/**
 * 工程卡片上的引擎版本文案。
 *
 * `.uproject` 里的 `EngineAssociation` 有两种写法：Launcher 装的引擎写 `"5.8"`，
 * 自己拉源码编的引擎写一串 `{DAB4E4C9-4ACB-...}` 的 GUID。直接把字段摆到卡片上，
 * 后者看起来就是一坨乱码 —— 这里统一翻成版本号再显示。
 *
 * GUID → 版本号的映射只有主进程能查（在 Windows 注册表里），所以走一次 IPC，
 * 结果按模块级缓存，多个列表组件共用，同一个 GUID 不会重复查注册表。
 */
const labelCache = ref<Record<string, string>>({})

/** 未解析出结果时卡片上显示的占位文案 */
const FALLBACK_LABEL = 'N/A'

const normalize = (association: string | null | undefined): string =>
  String(association || '').trim()

export function useEngineVersionLabel(): {
  ensureEngineLabels: (associations: (string | null | undefined)[]) => Promise<void>
  engineLabel: (association: string | null | undefined) => string
} {
  /** 把列表里还没查过的 EngineAssociation 批量送去主进程解析 */
  const ensureEngineLabels = async (associations: (string | null | undefined)[]): Promise<void> => {
    const pending = Array.from(
      new Set(associations.map(normalize).filter((a) => a && !(a in labelCache.value)))
    )
    if (!pending.length) return

    try {
      const ret = await window.api.unrealPath.resolveEngineAssociations(pending)
      const data = ret?.success ? ret.data || {} : {}
      // 查失败的也要落缓存（空串），否则每次列表刷新都会再查一遍注册表
      labelCache.value = {
        ...labelCache.value,
        ...Object.fromEntries(pending.map((a) => [a, data[a] ?? '']))
      }
    } catch (error) {
      console.warn('[useEngineVersionLabel] 解析引擎版本失败:', error)
    }
  }

  const engineLabel = (association: string | null | undefined): string => {
    const key = normalize(association)
    if (!key) return FALLBACK_LABEL
    // 还没查回来时先按普通版本号显示；GUID 宁可显示 N/A，也别闪一下乱码
    const cached = labelCache.value[key]
    if (cached === undefined) return key.startsWith('{') ? FALLBACK_LABEL : key
    return cached || FALLBACK_LABEL
  }

  return { ensureEngineLabels, engineLabel }
}
