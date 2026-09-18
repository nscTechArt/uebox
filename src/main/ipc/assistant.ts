import { ipcMain, BrowserWindow } from 'electron'

interface AskArgs {
  content: string
  conversationId?: string | null
}

/**
 * 注册虚幻AI助手相关的 IPC
 * 说明：主进程使用 fetch 发起 EpicGames Assistant 的 SSE 请求，并将流式片段转发到渲染进程。
 */
export function registerAssistantIPC(): void {
  ipcMain.handle('assistant:ask', async (event, args: AskArgs) => {
    const web = BrowserWindow.getFocusedWindow()?.webContents || event.sender
    try {
      const url = 'https://dev.epicgames.com/community/api/assistant/questions'

      // 固定请求头（按用户要求）
      const headers: Record<string, string> = {
        accept: 'text/event-stream',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'cache-control': 'no-cache',
        'cb-guest-id': '01K9BVNY7V484M28KZN5ZV84PB',
        'content-type': 'application/json',
        pragma: 'no-cache',
        priority: 'u=1, i',
        'public-csrf-token':
          'cPbq3YqstwbDOexZXbCuvZTrDgU4ouZjtty/E4n9VG6uFJU75UL33vzdpzFWs8er8EV7yaaOmYP7rWbOvajtEQ==',
        'sec-ch-ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'x-environment-descriptor':
          'Web/Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        cookie:
          '_tald=0b66c241-a741-4802-9adc-e634c143f80a; EPIC_DEVICE=832ebded033247ed860b003e66bdd725; dfpfpt=ad53f7c614b04ad9a5d724dd63771c6d; OptanonConsent=isIABGlobal=false&datestamp=Wed+Sep+24+2025+12%3A39%3A30+GMT%2B0800+(%E4%B8%AD%E5%9B%BD%E6%A0%87%E5%87%86%E6%97%B6%E9%97%B4)&version=6.7.0&hosts=&consentId=3f839f6d-f298-437c-b75c-eb027354a5d3&interactionCount=2&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A0&AwaitingReconsent=false&geolocation=NL%3B; EpicOptanonConsent=isIABGlobal=false&datestamp=Wed+Sep+24+2025+12%3A39%3A30+GMT%2B0800+(%E4%B8%AD%E5%9B%BD%E6%A0%87%E5%87%86%E6%97%B6%E9%97%B4)&version=6.7.0&hosts=&consentId=3f839f6d-f298-437c-b75c-eb027354a5d3&interactionCount=2&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1%2CC0004%3A0&AwaitingReconsent=false&geolocation=NL%3B; __cf_bm=9wV8rwEMLlrbNRZ47eYr7v08qvEqANKmed_icOS9oQ4-1762408394-1.0.1.1-fHyVyt2bLNfLSx.4NKxZUNvhWAarwQBA8wdfXFUz_T_lDG_vKCjM7puD2x8YK1RAQnIMm63MjD.hTDSIwNnJA5.xcQvbzZgiErq6P4GFMCM; _epicSID=692b96361ece464a8fd07f84b5c01c7e; PRIVATE-CSRF-TOKEN=3uJ%2F5m%2FuQNg%2F5EtoCwNpFmSudcyeLH%2FgTXHZ3TRVuX8%3D; cf_clearance=086I_WH30.733QbeDRM2n4Vg6eX9l1bz3qPyelmkhNs-1762408400-1.2.1.1-_YCgoLkbE13B.GjGCnK.OYp9.BQTXkf57KXyP35i.DoY3XdfdjvQKw1jiqx3lLIzocSkTijGtBa9FLSZ.1cizT8uRLAor90XKl4UiS7gag',
        Referer: 'https://dev.epicgames.com/community/assistant/unreal-engine/conversation'
      }

      const bodyObj: Record<string, unknown> = {
        content: String(args?.content || ''),
        application: 'unreal_engine',
        format: 'html'
      }
      if (args?.conversationId) {
        bodyObj.conversation_id = String(args.conversationId)
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyObj)
      })

      if (!res.ok) {
        web.send('assistant:error', { status: res.status })
        return { success: false }
      }

      const reader = res.body?.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      if (!reader) {
        web.send('assistant:error', { message: '响应不可读' })
        return { success: false }
      }

      // 逐块读取并解析 SSE 格式
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE 事件以空行分隔
        const events = buffer.split('\n\n')
        buffer = events.pop() || ''
        for (const evt of events) {
          const lines = evt.split('\n')
          for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed.startsWith('data:')) {
              const data = trimmed.slice(5).trim()
              // 转发原始片段
              web.send('assistant:chunk', data)
              // 尝试从 JSON 中提取 conversation_id
              try {
                const obj = JSON.parse(data)
                const cid = (obj?.conversation_id || obj?.conversationId) as string | undefined
                if (cid) {
                  web.send('assistant:conversation', cid)
                }
              } catch {}
            }
          }
        }
      }

      web.send('assistant:done')
      return { success: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      const web = BrowserWindow.getFocusedWindow()?.webContents || event.sender
      web.send('assistant:error', { message: msg })
      return { success: false }
    }
  })
}
