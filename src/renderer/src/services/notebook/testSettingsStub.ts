/**
 * 给单测用的 `window.api.settings` 桩。
 *
 * 产出配方跑之前会读一次自定义提示词。不给桩的话每个用例都要打一行
 * 「读取失败，本次用出厂默认」的 warn —— 用例照样过，但真出问题时那行 warn
 * 淹在一堆同样的 warn 里，没人会注意到。
 */

type SettingsApi = {
  get: (key: string, defaultValue?: unknown) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<boolean>
}

/** 把设置读写换成传进来的实现；不传就是「什么都没存过」 */
export function stubSettingsApi(settings?: Partial<SettingsApi>): void {
  const host = globalThis as unknown as { window?: { api?: { settings?: SettingsApi } } }
  const api = {
    get: settings?.get ?? (async () => null),
    set: settings?.set ?? (async () => true)
  }

  host.window = { ...(host.window ?? {}), api: { ...(host.window?.api ?? {}), settings: api } }
}
