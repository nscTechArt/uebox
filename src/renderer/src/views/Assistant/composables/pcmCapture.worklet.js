/**
 * 把麦克风的 Float32 采样转成 PCM16，**按 20 毫秒一包**抛回主线程。
 *
 * ## 为什么必须是 AudioWorklet
 *
 * 实时语音要的是**连续的裸采样流**。MediaRecorder 给的是 webm/opus 容器分片，
 * 拆不出可以直接续上的 PCM；ScriptProcessorNode 能给，但它跑在主线程上，
 * 界面一忙就丢帧 —— 而丢帧在语音里表现为对面听到的话缺字。
 * Worklet 跑在音频线程上，界面卡不影响它。
 *
 * ## 为什么要凑成 20ms
 *
 * Worklet 的一个处理块固定 128 帧 —— 16kHz 下只有 8ms。两家厂商的文档和官方
 * demo 都是 20ms 一包：包太小意味着每秒上百条 IPC + WebSocket 消息，纯属浪费；
 * 而全双工那边还靠上行节奏做判停。所以这里攒够 20ms 再发。
 *
 * ## 为什么在这里就转成 Int16
 *
 * Float32 比 Int16 大一倍，而两端都只要 PCM16。在音频线程上转完再过线程边界，
 * 传输量减半，主线程也少一次遍历。
 *
 * 重采样**不在这里做**：AudioContext 用目标采样率创建，浏览器会把麦克风的原始
 * 采样率直接重采样进来，比手写插值又准又省。
 */

/** 一包多少毫秒。两家厂商都推荐 20 */
const PACKET_MS = 20

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // sampleRate 是 AudioWorkletGlobalScope 的全局量，等于创建 AudioContext 时
    // 指定的那个 —— 所以一包多少个采样点不用从外面传进来
    this.packetSamples = Math.round((sampleRate * PACKET_MS) / 1000)
    this.buffer = new Int16Array(this.packetSamples)
    this.filled = 0
  }

  /**
   * @param {Float32Array[][]} inputs
   * @returns {boolean} 恒为 true —— 返回 false 会让音频线程回收这个节点，
   *   麦克风就此静默，而且没有任何报错
   */
  // 这个文件跑在 AudioWorklet 的全局作用域里（AudioWorkletProcessor、
  // registerProcessor、sampleRate 都不在 TS 的 lib 里），所以它只能是 .js
  // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
  process(inputs) {
    const channel = inputs[0]?.[0]
    // 没有输入的那几帧（设备还没就绪、轨道被暂停）直接跳过
    if (!channel || channel.length === 0) return true

    for (let i = 0; i < channel.length; i += 1) {
      // 先夹再缩放：采样偶尔会略微超出 ±1，不夹的话溢出会绕回去，
      // 听起来是"咔"的一声爆音
      const clamped = Math.max(-1, Math.min(1, channel[i]))
      this.buffer[this.filled] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
      this.filled += 1

      if (this.filled === this.packetSamples) {
        // 转移所有权而不是拷贝，随后换一块新的继续攒
        const packet = this.buffer
        this.port.postMessage(packet.buffer, [packet.buffer])
        this.buffer = new Int16Array(this.packetSamples)
        this.filled = 0
      }
    }

    return true
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor)
