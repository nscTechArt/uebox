import { computed, ref } from 'vue'
import { readEngineScan, type EngineScanOutcome } from './engineScanResult'

export type EngineItem = {
  name: string
  version: string
  channel: string
  rootPath: string
  enginePath: string
  pluginPath: string
}

export function mapEngineInfoToItem(value: unknown): EngineItem {
  const info = value as Partial<EngineItem> | null | undefined
  return {
    name: String(info?.name || ''),
    version: String(info?.version || ''),
    channel: String(info?.channel || 'Epic Launcher'),
    rootPath: String(info?.rootPath || ''),
    enginePath: String(info?.enginePath || ''),
    pluginPath: String(info?.pluginPath || '')
  }
}

// Renderer-session cache: page remounts keep the last list while scanning in the background.
const engines = ref<EngineItem[]>([])
const initialized = ref(false)
const scanFailed = ref(false)
const initLoading = computed(() => !initialized.value && engines.value.length === 0)
let pending: Promise<EngineScanOutcome<EngineItem>> | null = null

async function scan(): Promise<EngineScanOutcome<EngineItem>> {
  let outcome: EngineScanOutcome<EngineItem> = {
    ok: false,
    engines: null,
    syncSelections: false
  }
  try {
    outcome = readEngineScan(await window.api.unrealPath.scanEngines(), mapEngineInfoToItem)
  } catch (error) {
    console.warn('[EngineSection] Engine scan failed:', error)
  }
  if (outcome.engines) engines.value = outcome.engines
  scanFailed.value = !outcome.ok
  initialized.value = true
  return outcome
}

function refresh(): Promise<EngineScanOutcome<EngineItem>> {
  pending ??= scan().finally(() => {
    pending = null
  })
  return pending
}

export function useEngineList(): {
  engines: typeof engines
  scanFailed: typeof scanFailed
  initLoading: typeof initLoading
  refresh: typeof refresh
} {
  return { engines, scanFailed, initLoading, refresh }
}
