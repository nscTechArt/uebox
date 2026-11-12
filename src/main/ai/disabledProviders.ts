import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'
import { MODEL_ROLES, type ModelRole, type ProviderConfig, type RoleBindings } from './types'
import { normalizeSettings, readSettings, updateSettings } from './store'

/**
 * 停用的来源。
 *
 * 停用 = 把整条配置从 `models.json` 挪到旁边的 `models.disabled.json`。应用里读模型配置的地方
 * 有上百处（角色回落、对话钉的模型、后台起标题、套餐对账……），挪走之后它们一个都看不见它，
 * 不用逐处加过滤，也就不会漏掉哪一处还在偷偷调用。启用时原样挪回来。
 *
 * 停用时它绑着的角色记在条目里，启用时那几个角色若还空着就绑回去 —— 停用期间用户另选了的不动。
 *
 * 两个文件不是一次写完的：停用先写这边再删那边，启用先加那边再删这边。中途断掉最多两边各有一份，
 * 读的时候以 `models.json` 为准（见 `readDisabledProviders`）。
 */

const DISABLED_FILE = 'models.disabled.json'

interface DisabledEntry {
  provider: ProviderConfig
  /** 停用前绑着它的角色，各自绑的哪个模型 */
  roles: Array<{ role: ModelRole; modelId: string }>
}

function disabledPath(): string {
  return join(app.getPath('userData'), DISABLED_FILE)
}

async function readEntries(): Promise<DisabledEntry[]> {
  let raw: unknown
  try {
    raw = JSON.parse(await fs.readFile(disabledPath(), 'utf-8'))
  } catch {
    return []
  }
  const list = Array.isArray((raw as { providers?: unknown })?.providers)
    ? ((raw as { providers: unknown[] }).providers as Array<Record<string, unknown>>)
    : []
  return list.flatMap((item) => {
    const [provider] = normalizeSettings({ version: 3, providers: [item?.provider] }).providers
    if (!provider) return []
    const roles = (Array.isArray(item.roles) ? item.roles : []).flatMap((binding) => {
      const role = MODEL_ROLES.find((name) => name === binding?.role)
      const modelId = typeof binding?.modelId === 'string' ? binding.modelId : ''
      return role && modelId ? [{ role, modelId }] : []
    })
    return [{ provider, roles }]
  })
}

async function writeEntries(entries: DisabledEntry[]): Promise<void> {
  const path = disabledPath()
  if (entries.length === 0) {
    await fs.rm(path, { force: true })
    return
  }
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, `${JSON.stringify({ providers: entries }, null, 2)}\n`, 'utf-8')
}

let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task)
  queue = run.catch(() => undefined)
  return run
}

/** 停用的来源。`models.json` 里也有同 id 的（启用写到一半断了）不算停用 */
export async function readDisabledProviders(): Promise<ProviderConfig[]> {
  const enabled = new Set((await readSettings()).providers.map((item) => item.id))
  return (await readEntries())
    .map((entry) => entry.provider)
    .filter((provider) => !enabled.has(provider.id))
}

function rolesBoundTo(roles: RoleBindings, providerId: string): DisabledEntry['roles'] {
  return MODEL_ROLES.flatMap((role) => {
    const binding = roles[role]
    return binding?.providerId === providerId ? [{ role, modelId: binding.modelId }] : []
  })
}

export function disableProvider(providerId: string): Promise<void> {
  return enqueue(async () => {
    const settings = await readSettings()
    const provider = settings.providers.find((item) => item.id === providerId)
    if (!provider) return
    const roles = rolesBoundTo(settings.roles, providerId)
    const others = (await readEntries()).filter((entry) => entry.provider.id !== providerId)
    await writeEntries([...others, { provider, roles }])
    // 指向它的角色绑定由 normalizeSettings 丢掉
    await updateSettings((current) => ({
      ...current,
      providers: current.providers.filter((item) => item.id !== providerId)
    }))
  })
}

export function enableProvider(providerId: string): Promise<void> {
  return enqueue(async () => {
    const entries = await readEntries()
    const entry = entries.find((item) => item.provider.id === providerId)
    if (!entry) return
    await updateSettings((current) => {
      if (current.providers.some((item) => item.id === providerId)) return current
      const roles = { ...current.roles }
      for (const { role, modelId } of entry.roles) {
        const exists = entry.provider.models.some((model) => model.id === modelId)
        if (!roles[role] && exists) roles[role] = { providerId, modelId }
      }
      return { ...current, providers: [...current.providers, entry.provider], roles }
    })
    await writeEntries(entries.filter((item) => item !== entry))
  })
}

/** 改一条停用中的来源（设置页里编辑它）。不存在时返回 false，调用方按启用中的处理 */
export function updateDisabledProvider(provider: ProviderConfig): Promise<boolean> {
  return enqueue(async () => {
    const entries = await readEntries()
    const index = entries.findIndex((item) => item.provider.id === provider.id)
    if (index < 0) return false
    entries[index] = { ...entries[index], provider }
    await writeEntries(entries)
    return true
  })
}

/** 删一条停用中的来源。返回被删的那条，没有则 null */
export function deleteDisabledProvider(providerId: string): Promise<ProviderConfig | null> {
  return enqueue(async () => {
    const entries = await readEntries()
    const entry = entries.find((item) => item.provider.id === providerId)
    if (!entry) return null
    await writeEntries(entries.filter((item) => item !== entry))
    return entry.provider
  })
}
