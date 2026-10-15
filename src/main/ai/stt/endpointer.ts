/**
 * 静音断句：从连续的麦克风 PCM 里切出「一句话」。
 *
 * ## 为什么要自己断句
 *
 * 豆包、百炼那两家是流式识别，断句在厂商那边做（VAD 判停后回一条终稿）。
 * OpenAI 兼容的转写接口（`/v1/audio/transcriptions`，本机 SenseVoice、Whisper、
 * 硅基流动都是这一种）**收一整段音频、回一整段文字**，不会替我们判断说完没有。
 * Spotlight 的「点一下说话、说完自动提交」靠的就是那条终稿，没人断句的话
 * 用户说完一句，输入框永远是空的。
 *
 * ## 怎么判
 *
 * 按 20 毫秒一帧算响度，和**最近一段时间里最安静的那一帧**比：高出一截算有人说话。
 * 拿「最安静的那一帧」当底噪，是因为人说话时字与字之间总有换气、停顿，
 * 一秒多的窗口里一定落得到一次 —— 所以持续的风扇声会被认成底噪，而连续说话不会。
 *
 * 采集那头开着浏览器的降噪和自动增益（`useVoiceDictation.openMicrophone`），
 * 响度已经被拉到一个稳定的范围，这里只做最朴素的那一档判断。
 */

/** 一帧多少毫秒。和采集 worklet 的包长一致 */
const FRAME_MS = 20

/** 说完之后静多久算这句话结束。和豆包、百炼那两条线取同一个数，三家的停顿手感才一致 */
const SILENCE_MS = 800

/**
 * 开口之前留多少音频。
 *
 * 判出「有人说话」要连着几帧够响，而一句话的第一个辅音往往不够响 ——
 * 不往前补一点，每句话都会被吃掉开头的半个字。
 *
 * 它也兜住了刚开麦那一下：底噪还没攒出来时（热键一按就开口），最安静的那一帧
 * 就是用户的字，要等第一次换气才判得出开口。那一两百毫秒在这段里补回来。
 */
const PREROLL_MS = 300

/** 结尾留多少静音。识别模型需要一点尾巴才敢确认最后一个字，留满 800 毫秒又是白传 */
const TAIL_MS = 200

/**
 * 一句话最长多少。超了就地切一刀。
 *
 * Whisper 一系按 30 秒一个窗口处理，更长的音频服务端也是切开了再拼；
 * 我们切的好处是用户一口气说很久时，前半段的字先出来。
 */
const MAX_SEGMENT_MS = 30_000

/** 底噪取最近这么久里最安静的一帧。要比一句话里最长的连续发声长 */
const FLOOR_WINDOW_MS = 1_500

/** 比底噪高出这么多分贝算有人说话 */
const SPEECH_MARGIN_DB = 12

/** 不管底噪多低，低于这个响度都不算说话。降噪开着时底噪能低到 -80，只靠上一条会把呼吸声当成话 */
const SPEECH_FLOOR_DB = -50

/** 最近这几帧里有这么多帧够响，才算开口。一帧的爆音（碰了一下麦）不算 */
const ONSET_WINDOW = 5
const ONSET_VOICED = 3

/** 一段里够响的帧少于这么多就扔掉，不送去识别。一声咳嗽、一下键盘 */
const MIN_VOICED_MS = 160

export interface EndpointerOptions {
  /** PCM16 单声道的采样率 */
  sampleRate: number
  /**
   * 低于这个响度一律不算说话，默认 `SPEECH_FLOOR_DB`。
   *
   * 拼装通话拿它判「用户插话」：外放时喇叭的回声残留会被收回来，门槛得跟着
   * 回声档位抬高，不然它自己的声音就把自己打断了。
   */
  speechFloorDb?: number
}

export interface Endpointer {
  /**
   * 送一段 PCM16 小端单声道。长度不必对齐帧，余下的留到下一次。
   *
   * 回这一段里**说完了**的那几句（通常是空数组）。
   */
  push: (pcm: Buffer) => Buffer[]
  /**
   * 音频到此为止：正在说的那句不等静音了，直接收。没在说就回 `null`。
   *
   * 「按住说话」松手时走这条 —— 松手本身就是「说完了」。
   */
  end: () => Buffer | null
  /** 此刻是不是在一句话里 */
  readonly speaking: boolean
}

/** 一帧的响度，dBFS。全零帧给一个足够低的数而不是 -Infinity，免得比较时出怪事 */
export function frameLevelDb(frame: Buffer): number {
  const samples = frame.length >> 1
  if (!samples) return -100
  let sum = 0
  for (let i = 0; i < samples; i += 1) {
    const value = frame.readInt16LE(i * 2) / 0x8000
    sum += value * value
  }
  const rms = Math.sqrt(sum / samples)
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100
}

export function createEndpointer(options: EndpointerOptions): Endpointer {
  const frameBytes = ((options.sampleRate * FRAME_MS) / 1000) * 2
  const frames = (ms: number): number => Math.round(ms / FRAME_MS)
  const silenceFrames = frames(SILENCE_MS)
  const prerollFrames = frames(PREROLL_MS)
  const tailFrames = frames(TAIL_MS)
  const maxSegmentFrames = frames(MAX_SEGMENT_MS)
  const minVoicedFrames = frames(MIN_VOICED_MS)
  const speechFloorDb = options.speechFloorDb ?? SPEECH_FLOOR_DB

  /** 上一次没凑满一帧的零头 */
  let remainder = Buffer.alloc(0)
  /**
   * 最近一段的响度，取最小值当底噪。
   *
   * **开头不垫假定值**：垫一个「安静房间」的数，吵一点的房间里开麦头一秒半的
   * 风扇声全被当成话，送去识别回来一句幻觉。从真实的第一帧起算，最坏是开口晚判一点，
   * 那一点由 PREROLL_MS 补回来。
   */
  const levels: number[] = []
  const floorWindow = frames(FLOOR_WINDOW_MS)
  /** 开口之前的那一小段，见 PREROLL_MS */
  let preroll: Buffer[] = []
  /** 最近几帧够不够响，判开口用 */
  let recentVoiced: boolean[] = []

  let speaking = false
  let segment: Buffer[] = []
  let segmentVoiced = 0
  /** 这句话末尾连着多少帧不够响 */
  let trailingSilence = 0

  function take(): Buffer | null {
    // 末尾那串静音只留一小截，见 TAIL_MS
    const drop = Math.max(0, trailingSilence - tailFrames)
    const kept = drop ? segment.slice(0, segment.length - drop) : segment
    const enough = segmentVoiced >= minVoicedFrames
    speaking = false
    segment = []
    segmentVoiced = 0
    trailingSilence = 0
    return enough && kept.length ? Buffer.concat(kept) : null
  }

  function accept(frame: Buffer): Buffer | null {
    const level = frameLevelDb(frame)
    levels.push(level)
    if (levels.length > floorWindow) levels.shift()
    const floor = Math.min(...levels)
    const voiced = level >= Math.max(floor + SPEECH_MARGIN_DB, speechFloorDb)

    if (!speaking) {
      recentVoiced.push(voiced)
      if (recentVoiced.length > ONSET_WINDOW) recentVoiced.shift()
      preroll.push(frame)
      if (preroll.length > prerollFrames) preroll.shift()
      if (recentVoiced.filter(Boolean).length < ONSET_VOICED) return null
      // 开口了：前面那一小段一起算进这句话
      speaking = true
      segment = preroll
      segmentVoiced = recentVoiced.filter(Boolean).length
      trailingSilence = 0
      preroll = []
      recentVoiced = []
      return null
    }

    segment.push(frame)
    if (voiced) {
      segmentVoiced += 1
      trailingSilence = 0
    } else {
      trailingSilence += 1
    }
    if (trailingSilence >= silenceFrames) return take()
    if (segment.length >= maxSegmentFrames) {
      // 一口气说太久：切一刀交出去，人还在说，所以下一段直接接着算「在说话」
      const cut = take()
      speaking = true
      return cut
    }
    return null
  }

  return {
    push(pcm) {
      const data = remainder.length ? Buffer.concat([remainder, pcm]) : pcm
      const done: Buffer[] = []
      let offset = 0
      for (; offset + frameBytes <= data.length; offset += frameBytes) {
        const sentence = accept(data.subarray(offset, offset + frameBytes))
        if (sentence) done.push(sentence)
      }
      remainder = Buffer.from(data.subarray(offset))
      return done
    },
    end() {
      remainder = Buffer.alloc(0)
      preroll = []
      recentVoiced = []
      return speaking ? take() : null
    },
    get speaking() {
      return speaking
    }
  }
}
