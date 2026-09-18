import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { writeSessionFile } from '../../agent-v3/core/atomicSessionFile'
import { safeSessionFileBase, sessionsDir } from '../../agent-v3/core/transcriptStore'
import { checkNavigationUrl } from './urlPolicy'

function statePath(sessionId: string): string {
  return join(sessionsDir(), `${safeSessionFileBase(sessionId)}.browser.json`)
}

/** 只记录最后一个页面；Cookie 仍由 Chromium 的持久 partition 管理。 */
export async function saveBrowserUrl(sessionId: string, url: string | null): Promise<void> {
  if (url === null) {
    await fs.rm(statePath(sessionId), { force: true })
    return
  }
  const checked = checkNavigationUrl(url)
  if (!checked.ok) throw new Error('Invalid saved browser URL')
  await writeSessionFile(statePath(sessionId), JSON.stringify({ url: checked.url.toString() }))
}

export async function loadBrowserUrl(sessionId: string): Promise<string | undefined> {
  try {
    const saved: unknown = JSON.parse(await fs.readFile(statePath(sessionId), 'utf8'))
    if (!saved || typeof saved !== 'object' || !('url' in saved) || typeof saved.url !== 'string') {
      throw new Error('Invalid browser session state')
    }
    const checked = checkNavigationUrl(saved.url)
    if (!checked.ok) throw new Error('Invalid saved browser URL')
    return checked.url.toString()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export interface SavedBrowserGroup {
  urls: string[]
  activeIndex: number
  mode?: 'embedded' | 'window' | 'hidden'
}

export async function saveBrowserGroup(sessionId: string, state: SavedBrowserGroup): Promise<void> {
  if (!state.urls.length) return saveBrowserUrl(sessionId, null)
  for (const url of state.urls) {
    if (url !== 'about:blank' && !checkNavigationUrl(url).ok)
      throw new Error('Invalid saved browser URL')
  }
  await writeSessionFile(statePath(sessionId), JSON.stringify(state))
}

export async function loadBrowserGroup(sessionId: string): Promise<SavedBrowserGroup | undefined> {
  let saved: unknown
  try {
    saved = JSON.parse(await fs.readFile(statePath(sessionId), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!saved || typeof saved !== 'object') throw new Error('Invalid browser session state')
  if ('url' in saved) {
    const url = await loadBrowserUrl(sessionId)
    return url ? { urls: [url], activeIndex: 0 } : undefined
  }
  const state = saved as SavedBrowserGroup
  if (
    !Array.isArray(state.urls) ||
    state.urls.length > 100 ||
    !state.urls.every(
      (url) => typeof url === 'string' && (url === 'about:blank' || checkNavigationUrl(url).ok)
    ) ||
    !Number.isInteger(state.activeIndex) ||
    state.activeIndex < 0 ||
    state.activeIndex >= state.urls.length ||
    (state.mode !== undefined && !['window', 'embedded', 'hidden'].includes(state.mode))
  ) {
    throw new Error('Invalid browser session state')
  }
  return state
}
