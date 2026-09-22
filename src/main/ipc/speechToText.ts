import { ipcMain, type WebContents } from 'electron'
import {
  STT_INPUT_SAMPLE_RATE,
  hasSttAdapter,
  openSttSession,
  resolveSttBinding,
  type SttSessionHandle
} from '../ai/stt'
import { isRealtimeVoiceBusy } from './realtimeVoice'

/**
 * 听写（语音识别）会话的 IPC。
 *
 * ## 为什么不挂在 `realtime-voice:*` 下面
 *
 * 那条通道上的会话句柄带着 `announce` / `cancelResponse` / `sendToolResults`
 * ——「让模型说一句」「打断它」「把工具结果交回去」。识别这一路**一个都没有**，
 * 它只会出字。塞进同一个句柄里意味着实现三个永远抛不出、也永远不会被调用的
 * 方法，而读代码的人得逐个去确认那三个到底会不会走。
 *
 * 两条通道也让「谁占着麦克风」这件事显式了：见下面 `busy` 那一段。
 *
 * ## 渲染层怎么选路
 *
 * 渲染层先问这边的 `audio-spec`：绑了「语音识别」角色就回采样率，没绑回
 * `ok: false`，它再去走实时语音那一路（行为与这一档出现之前一致）。
 * 判断放在主进程是因为**角色绑定只有主进程读得到** —— 渲染层没有
 * `models.json` 的访问权，也不该有。
 */

/** 同一时间只允许一路识别。开两路的表现是同一句话被识别两遍，账单也翻倍 */
let active: { handle: SttSessionHandle; sender: WebContents } | null = null

function stop(): void {
  const previous = active
  active = null
  previous?.handle.close()
}

export function registerSpeechToTextIPC(): void {
  /**
   * 上行要多少赫兹，**在开会话之前问**。
   *
   * 同时兼着「这一路能不能走」的判据：`ok: false` 表示没绑语音识别角色，
   * 渲染层据此回落。合成一条是因为这两个问题的答案来自同一次配置读取，
   * 分成两条的话调用方要发两次 IPC 才敢开麦克风，而它正等着开麦克风。
   */
  ipcMain.handle('stt:audio-spec', async () => {
    try {
      const binding = await resolveSttBinding()
      if (!binding || !hasSttAdapter(binding.baseUrl)) return { ok: false as const }
      return { ok: true as const, inputSampleRate: STT_INPUT_SAMPLE_RATE }
    } catch {
      // 绑了但 Provider 被删了。这里不报错，让渲染层去走实时语音那一路 ——
      // 那条路上的报错信息更全，它会告诉用户去哪儿改
      return { ok: false as const }
    }
  })

  /**
   * 开一路识别会话。
   *
   * 失败按类型返回而不是抛，理由和听写那一路一样：调用方对每一类的处置不同。
   * `busy` / `unconfigured` 静默退回（前者退回打字，后者退回实时语音那一路），
   * 只有 `failed` 需要把话说给用户听。
   */
  ipcMain.handle('stt:start', async (event) => {
    /*
     * 助手页正在通话就让路，**不抢**。
     *
     * 这两路用的是两条独立连接，真要同时开也开得起来 —— 但麦克风只有一个，
     * 人也只有一个。同时开的结果是用户对着 Spotlight 说的话同时进了助手的
     * 通话，助手会当场接话。见 `isRealtimeVoiceBusy`。
     */
    if (isRealtimeVoiceBusy()) return { ok: false as const, reason: 'busy' as const }
    // 上一路还开着（同一个窗口重开、或者另一个窗口抢）先收掉，别留两路
    stop()

    let binding: Awaited<ReturnType<typeof resolveSttBinding>>
    try {
      binding = await resolveSttBinding()
    } catch (error) {
      return {
        ok: false as const,
        reason: 'failed' as const,
        error: error instanceof Error ? error.message : String(error)
      }
    }
    if (!binding) return { ok: false as const, reason: 'unconfigured' as const }
    if (!hasSttAdapter(binding.baseUrl)) {
      return {
        ok: false as const,
        reason: 'failed' as const,
        error: '认不出这个语音识别服务商。目前支持豆包语音（openspeech）与阿里云百炼。'
      }
    }

    try {
      const sender = event.sender
      const handle = openSttSession(binding, (payload) => {
        // 这一路的事件全都要转给渲染层 —— 它只有五种，每一种界面上都有对应的动作
        if (sender.isDestroyed()) {
          stop()
          return
        }
        sender.send('stt:event', payload)
        if (payload.type === 'closed' || payload.type === 'error') {
          // 厂商关的那一路就别留在 active 上了，否则下一次听写会被自己上一轮挡成
          // 「正忙」，直到重启 —— 实时语音那条线真踩过这个坑
          if (active?.handle === handle) active = null
        }
      })
      active = { handle, sender }
      return { ok: true as const, inputSampleRate: STT_INPUT_SAMPLE_RATE }
    } catch (error) {
      return {
        ok: false as const,
        reason: 'failed' as const,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  /**
   * 送一段用户音频。
   *
   * 用 `on` 而不是 `handle`：这条一秒钟要走五十次，每次都等一个 Promise 往返
   * 纯属浪费 —— 而且没有任何返回值需要等。
   *
   * 查 sender 的理由同实时语音那条线：被顶掉的那一头要过几十毫秒才停得下来，
   * 这中间它的 worklet 照样 20 毫秒一包往上送。不查的话那几包会落进接手的那路
   * 会话里，和新主人的第一句话混在一起。
   */
  ipcMain.on('stt:audio', (event, base64: string) => {
    if (!active || active.sender.id !== event.sender.id) return
    active.handle.appendAudio(base64)
  })

  /**
   * 「按住说话」松手了：音频到此为止，但**终稿还要**。
   *
   * 和 `stt:stop` 的区别全在这儿 —— `stop` 一进门就不再往渲染层放事件，
   * 而收尾包换回来的那条终稿正是用户刚说完的最后一句。用 `stop` 收尾的表现是
   * 松开热键之后输入框里永远少一句，而且没有任何报错。
   *
   * 会话由适配器在终稿到手（或兜底超时）之后自己关，这里不用再调 `stop`。
   */
  ipcMain.handle('stt:flush', (event) => {
    if (active && active.sender.id !== event.sender.id) return { ok: true }
    active?.handle.flush()
    return { ok: true }
  })

  /** 不是自己那一路就什么都不做，但照样回 ok —— 理由见 `realtime-voice:stop` */
  ipcMain.handle('stt:stop', (event) => {
    if (active && active.sender.id !== event.sender.id) return { ok: true }
    stop()
    return { ok: true }
  })

  console.log('[语音识别 IPC] 处理器已注册')
}
