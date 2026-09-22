/**
 * 随包的厂商品牌图标。
 *
 * `eager + query=url` 让打包器把这些 svg 收进产物并给出最终地址；
 * **不能用运行时拼路径** —— 那样开发时看着好好的，打包后全是 404。
 *
 * 这份查表原来抄在 ProviderCatalogModal.vue 里，现在目录弹窗和管理弹窗的树
 * 都要用。抄两份的直接后果是：下次加厂商只改了一处，另一处静悄悄掉图标，
 * 而掉图标不报错 —— 界面上只是退回一个灰底字母，没人会发现。
 */
const LOGO_URLS = import.meta.glob('@renderer/assets/provider-logos/*.svg', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

/** 文件名（不含扩展名）→ 打包后的地址 */
const BY_NAME = new Map<string, string>(
  Object.entries(LOGO_URLS).map(([path, url]) => [
    path.slice(path.lastIndexOf('/') + 1, -'.svg'.length),
    url
  ])
)

/**
 * 按目录条目的 id 精确取图标。
 *
 * 目录里的 id 是我们自己定的，一定对得上文件名，所以**不做前缀匹配** ——
 * 做了的话 `openai-embedding` 这种还没画图标的条目会去蹭 `openai` 的，
 * 用户看到一个 OpenAI 标却点开一条向量化服务。
 */
export function catalogLogoUrl(id: string): string | undefined {
  return BY_NAME.get(id)
}

/**
 * 按**用户配置里**的 provider id 取图标，找不到再退一步按前缀找。
 *
 * 退这一步是因为配置里的 id 不一定等于目录 id：同一家加第二次时草稿 id 会被
 * 改成 `openai-image-2`，它仍旧是同一家。取最长的那个前缀，避免
 * `openai-realtime` 被更短的 `openai` 抢走。
 */
export function providerLogoUrl(id: string): string | undefined {
  const exact = BY_NAME.get(id)
  if (exact) return exact

  let best: string | undefined
  let bestLength = 0
  for (const [name, url] of BY_NAME) {
    if (id.startsWith(name) && name.length > bestLength) {
      best = url
      bestLength = name.length
    }
  }
  return best
}

/** 没有图标时的兜底：名字的头一个字 */
export function logoFallbackText(displayName: string): string {
  return displayName.trim().slice(0, 1)
}
