import { ipcMain, shell } from 'electron'
import { registerCreatorPlanIPC } from './creatorPlan/ipc'
import { startCreatorPlanRefresh } from './creatorPlan/refresh'
import { isPlanProvider } from '../../shared/creatorPlan'
import { registerSpeechIPC } from '../ipc/speech'
import { PROVIDER_CATALOG } from './catalog'
import {
  deleteLiteralKey,
  hasApiKey,
  isEncryptionAvailable,
  parseApiKeyInput,
  saveLiteralKey,
  saveOAuthTokens,
  EncryptionUnavailableError
} from './credentials'
import { OAuthCancelledError, runOAuthLogin, yieldsPermanentKey } from './oauth'
import { listRemoteModels, testProvider } from './probe'
import { invalidateSettingsCache, readSettings, settingsPath, updateSettings } from './store'
import { isLocalModelConfigured } from './resolveModel'
import type { AiProviderSettings, ProviderConfig } from './types'
import {
  applyRolePatch,
  sanitizeRolePatch,
  unsavedRoles,
  type ProbeFailure,
  type ProviderDraft,
  type ProviderView,
  type SettingsView
} from '../../shared/aiProvider'

/**
 * Provider 配置 IPC。
 *
 * 关键约束：**明文密钥只单向流动**。渲染层可以写一个新密钥进来，但读不回去 ——
 * 返回给界面的 provider 一律把 apiKey 换成 `hasKey: boolean`。
 *
 * 线格式定义在 `src/shared/aiProvider.ts`，渲染层与这里共用同一份，
 * 免得两边各写一份 interface 之后悄悄漂移。
 */

async function toView(settings: AiProviderSettings): Promise<SettingsView> {
  const providers = await Promise.all(
    settings.providers.map(async (provider): Promise<ProviderView> => {
      const { apiKey, ...rest } = provider
      if (apiKey.kind === 'none') return { ...rest, apiKey: { kind: 'none' } }
      const present = await hasApiKey(apiKey)
      // env / shell 带着值回显：它们是「怎么取密钥」而不是密钥，界面要把它
      // 填回那个单一输入框。literal 只回 hasKey。
      if (apiKey.kind === 'env') {
        return { ...rest, apiKey: { kind: 'env', name: apiKey.name, hasKey: present } }
      }
      if (apiKey.kind === 'shell') {
        return { ...rest, apiKey: { kind: 'shell', command: apiKey.command, hasKey: present } }
      }
      if (apiKey.kind === 'oauth') {
        return {
          ...rest,
          apiKey: { kind: 'oauth', provider: apiKey.provider, hasKey: present }
        }
      }
      return { ...rest, apiKey: { kind: 'literal', hasKey: present } }
    })
  )

  return {
    providers,
    roles: settings.roles,
    path: settingsPath(),
    encryptionAvailable: isEncryptionAvailable(),
    configured: await isLocalModelConfigured()
  }
}

/**
 * 把草稿落成可存盘的 ProviderConfig，必要时写入密钥库。
 *
 * 密钥输入框留空时的含义**取决于原来是哪一档**，见 ProviderDraft.apiKeyInput 的注释。
 *
 * 换掉的旧密文不在这里删，只回它的 id（`staleKeyId`）：保存要等配置真的落了盘再删 ——
 * 先删的话写盘一失败，来源还指着一份已经没了的密文；测试连接、拉模型列表也会走这里，
 * 它们根本不该删东西。
 */
async function materialize(
  draft: ProviderDraft,
  previous: ProviderConfig | undefined
): Promise<{ provider: ProviderConfig; staleKeyId: string | null }> {
  const { apiKeyInput, ...rest } = draft
  const parsed = parseApiKeyInput(apiKeyInput || '')

  let apiKey: ProviderConfig['apiKey']
  if (!parsed) {
    // 留空：原来是 literal 就沿用（明文读不回界面，用户不是"看着它删掉的"），
    // 其余情况按真的不要密钥处理。
    apiKey =
      previous?.apiKey.kind === 'literal' || previous?.apiKey.kind === 'oauth'
        ? previous.apiKey
        : { kind: 'none' }
  } else if (parsed.kind === 'env') {
    apiKey = { kind: 'env', name: parsed.name }
  } else if (parsed.kind === 'shell') {
    apiKey = { kind: 'shell', command: parsed.command }
  } else {
    // 密钥 id 跟着 provider id 走，改 provider 名不换 id，避免留下孤儿密文。
    const id = previous?.apiKey.kind === 'literal' ? previous.apiKey.id : `provider:${draft.id}`
    apiKey = await saveLiteralKey(id, parsed.value)
  }

  // 从 literal / oauth 换成别的来源时，原来那份密文成了孤儿，由保存方在落盘后删掉。
  // 新旧同一个 id（明文和登录令牌都按 provider:<id> 存）时新的已经覆盖了它，不能删
  const previousId =
    previous?.apiKey.kind === 'literal' || previous?.apiKey.kind === 'oauth'
      ? previous.apiKey.id
      : null
  const currentId = apiKey.kind === 'literal' || apiKey.kind === 'oauth' ? apiKey.id : null
  const staleKeyId =
    previousId && apiKey.kind !== previous?.apiKey.kind && previousId !== currentId
      ? previousId
      : null

  return { provider: { ...rest, apiKey }, staleKeyId }
}

/** 落盘之后删掉换下来的旧密文；别的来源还在用同一份（Box Plan 的几个来源共用一把 Key）就留着 */
async function dropStaleKey(keyId: string | null, providerId: string): Promise<void> {
  if (keyId && !(await keyUsedElsewhere(keyId, providerId))) await deleteLiteralKey(keyId)
}

/** 除了 `exceptProviderId`，还有没有别的来源引用这份密文 */
async function keyUsedElsewhere(keyId: string, exceptProviderId: string): Promise<boolean> {
  const settings = await readSettings()
  return settings.providers.some(
    (provider) =>
      provider.id !== exceptProviderId &&
      (provider.apiKey.kind === 'literal' || provider.apiKey.kind === 'oauth') &&
      provider.apiKey.id === keyId
  )
}

/**
 * Box Plan 的来源只读：它的地址、模型、Key 都由套餐卡片管，
 * 在这里改了或删了，卡片和配置就对不上了。界面上已经不给编辑入口，
 * 主进程再拦一道，防止绕过界面直接调 IPC。
 */
const PLAN_READ_ONLY = {
  ok: false,
  error: '这个来源由 Box Plan 管理，请在「Box Plan」卡片上操作。'
} as const

/** 换上（或加上）一个来源 */
function withProvider(providers: ProviderConfig[], provider: ProviderConfig): ProviderConfig[] {
  return providers.some((item) => item.id === provider.id)
    ? providers.map((item) => (item.id === provider.id ? provider : item))
    : [...providers, provider]
}

function fail(error: unknown): { ok: false; error: string } {
  if (error instanceof EncryptionUnavailableError) return { ok: false, error: error.message }
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

/**
 * 探测那两条路专用的失败信封。
 *
 * `test` / `list-models` 回的是 `ProbeFailure`（码 + 可选原文），而不是字符串 ——
 * 上面那个通用 `fail()` 回的是字符串，形状对不上。
 *
 * 这条路真会走到：`readSettings()` / `materialize()` 会抛（典型是系统没有安全存储，
 * `EncryptionUnavailableError`）。形状对不上时渲染层拿到的是 `[object Object]`
 * 或者一片空白 —— 恰恰是这次改动要消灭的那类症状。
 *
 * 归到 `unknown` 并把原文放进 `raw`：渲染层对这个码的处理就是「显示原文」，
 * 和改动之前完全一致。
 */
function failProbe(error: unknown): { ok: false; error: ProbeFailure } {
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, error: { code: 'unknown', raw: message } }
}

export function registerAiProviderIPC(): void {
  registerSpeechIPC()
  registerCreatorPlanIPC()
  // 没连接时每一轮都只读本机配置，不发请求
  startCreatorPlanRefresh()
  ipcMain.handle('ai-provider:catalog', () => PROVIDER_CATALOG)

  ipcMain.handle('ai-provider:get-settings', async () => {
    invalidateSettingsCache()
    return toView(await readSettings())
  })

  ipcMain.handle('ai-provider:save-provider', async (_event, draft: ProviderDraft) => {
    if (isPlanProvider(String(draft?.id ?? ''))) return PLAN_READ_ONLY
    try {
      const previous = (await readSettings()).providers.find((item) => item.id === draft.id)
      const { provider, staleKeyId } = await materialize(draft, previous)
      // 落盘这一步排进队里、在最新的配置上改：materialize 要等密钥库，这期间后台对账可能写过
      const saved = await updateSettings((settings) => ({
        ...settings,
        providers: withProvider(settings.providers, provider)
      }))
      await dropStaleKey(staleKeyId, provider.id)
      return { ok: true, data: await toView(saved) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('ai-provider:delete-provider', async (_event, providerId: string) => {
    if (isPlanProvider(String(providerId ?? ''))) return PLAN_READ_ONLY
    try {
      const target = (await readSettings()).providers.find((item) => item.id === providerId)
      // 指向它的角色绑定由 normalizeSettings 自动丢弃，这里不用手动清。
      const saved = await updateSettings((current) => ({
        ...current,
        providers: current.providers.filter((item) => item.id !== providerId)
      }))
      // 配置落了盘再删密文：先删的话写盘一失败，来源还在、Key 却没了
      if (target?.apiKey.kind === 'literal') await dropStaleKey(target.apiKey.id, providerId)
      return { ok: true, data: await toView(saved) }
    } catch (error) {
      return fail(error)
    }
  })

  /**
   * 只收改了的那几个角色（null = 清空），在队里、在最新的配置上合并。
   * 收整张表的话，渲染层手里那份旧表会把后台刚写的（套餐清单对账）或上一次还没回来的改动盖掉
   */
  ipcMain.handle('ai-provider:set-roles', async (_event, raw: unknown) => {
    try {
      const patch = sanitizeRolePatch(raw)
      const saved = await updateSettings((settings) => ({
        ...settings,
        roles: applyRolePatch(settings.roles, patch)
      }))
      const lost = unsavedRoles(saved.roles, patch)
      if (lost.length > 0) {
        return {
          ok: false,
          error: `没存上（${lost.join('、')}）：选的来源或模型已经不在了，重新打开设置页再选一次。`
        }
      }
      return { ok: true, data: await toView(saved) }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('ai-provider:test', async (_event, draft: ProviderDraft, modelId: string) => {
    try {
      const settings = await readSettings()
      const previous = settings.providers.find((item) => item.id === draft.id)
      return await testProvider((await materialize(draft, previous)).provider, modelId)
    } catch (error) {
      return failProbe(error)
    }
  })

  ipcMain.handle('ai-provider:list-models', async (_event, draft: ProviderDraft) => {
    try {
      const settings = await readSettings()
      const previous = settings.providers.find((item) => item.id === draft.id)
      return await listRemoteModels((await materialize(draft, previous)).provider)
    } catch (error) {
      return failProbe(error)
    }
  })

  ipcMain.handle('ai-provider:reveal-config', async () => {
    shell.showItemInFolder(settingsPath())
  })

  /**
   * 账号登录。
   *
   * 两条出口，取决于对方给的是什么：
   * - **永久 API Key**（OpenRouter）：回给渲染层填进输入框，用户再点保存，
   *   和手输密钥完全同一条路径
   * - **会过期的令牌**（ChatGPT、Kimi）：令牌不能进渲染层，所以这里**直接落盘**，
   *   把整个 provider 一并存好。登录即生效，用户不用再点保存
   */
  ipcMain.handle(
    'ai-provider:oauth-login',
    async (event, oauthProvider: string, draft: ProviderDraft) => {
      if (isPlanProvider(String(draft?.id ?? ''))) return PLAN_READ_ONLY
      try {
        const tokens = await runOAuthLogin(oauthProvider, (prompt) => {
          // 设备码流程要把这串码显示给用户，只能靠事件推出去
          event.sender.send('ai-provider:oauth-device-code', prompt)
        })

        if (yieldsPermanentKey(oauthProvider)) {
          return { ok: true, data: { key: tokens.accessToken } }
        }

        const previous = (await readSettings()).providers.find((item) => item.id === draft.id)
        // 密钥 id 跟着 provider id 走，与 literal 那条路保持一致
        const tokenId = `provider:${draft.id}`
        const apiKey = await saveOAuthTokens(tokenId, oauthProvider, tokens)

        const { apiKeyInput: _ignored, ...rest } = draft
        void _ignored
        const provider: ProviderConfig = { ...rest, apiKey }
        const saved = await updateSettings((current) => ({
          ...current,
          providers: withProvider(current.providers, provider)
        }))
        // 换成 oauth 之前如果存过明文密钥，落盘后把那份删掉，不留孤儿。
        // 明文默认也存在 provider:<id> 下 —— 和刚存的令牌是同一个 id，那就已经被覆盖了，不能删
        if (previous?.apiKey.kind === 'literal' && previous.apiKey.id !== tokenId) {
          await dropStaleKey(previous.apiKey.id, draft.id)
        }
        return { ok: true, data: { settings: await toView(saved) } }
      } catch (error) {
        if (error instanceof OAuthCancelledError) return { ok: false, error: error.message }
        return fail(error)
      }
    }
  )

  console.log('[AI Provider IPC] 处理器已注册')
}
