import { ipcMain } from 'electron'
import { synthesizeSpeech } from '../ai/speech'
import type { SpeechRequest, SpeechResult } from '../../shared/speech'

export function registerSpeechIPC(): void {
  const pending = new Map<number, { id: string; controller: AbortController }>()
  ipcMain.handle(
    'speech:synthesize',
    async (event, request: SpeechRequest): Promise<SpeechResult> => {
      if (
        !request ||
        typeof request.requestId !== 'string' ||
        request.requestId.length > 100 ||
        typeof request.text !== 'string'
      )
        return { success: false, error: 'TTS_INVALID_TEXT' }
      const sender = event.sender
      pending.get(sender.id)?.controller.abort()
      const current = { id: request.requestId, controller: new AbortController() }
      pending.set(sender.id, current)
      const abort = (): void => current.controller.abort()
      // 只在「真的换了一份文档」时掐掉：重载、loadURL。渲染进程用的是 hash 路由，
      // 用户切一次标签页就是一次同文档导航 —— 而 did-start-loading 连这个都会响
      // （Electron 44 实测：改 hash 就触发），拿它当信号会把正在念的话掐断。
      const abortOnReload = (
        details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
      ): void => {
        if (details.isMainFrame && !details.isSameDocument) abort()
      }
      sender.once('destroyed', abort)
      sender.on('did-start-navigation', abortOnReload)
      try {
        await synthesizeSpeech(request.text, current.controller.signal, (chunk) => {
          if (
            pending.get(sender.id) !== current ||
            current.controller.signal.aborted ||
            sender.isDestroyed()
          )
            return
          sender.send('speech:chunk', { requestId: request.requestId, ...chunk })
        })
        return { success: true, data: null }
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        return { success: false, error: /^TTS_[A-Z0-9_]+$/.test(code) ? code : 'TTS_FAILED' }
      } finally {
        sender.removeListener('destroyed', abort)
        sender.removeListener('did-start-navigation', abortOnReload)
        if (pending.get(sender.id) === current) pending.delete(sender.id)
      }
    }
  )
  ipcMain.handle('speech:cancel', (event, requestId: string) => {
    const current = pending.get(event.sender.id)
    if (current?.id === requestId) current.controller.abort()
  })
}
