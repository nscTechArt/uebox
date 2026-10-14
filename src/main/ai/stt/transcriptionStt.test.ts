/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  openTranscriptionSttSession,
  parseGradioEvents,
  parseTranscription,
  pcmToWav,
  planGradioCall,
  readTranscript,
  probeTranscription,
  resolveTranscriptionTarget,
  stripSenseVoiceTags,
  transcribePcm
} from './transcriptionStt'
import type { SttEvent } from './types'

const RATE = 16_000

function tone(ms: number): Buffer {
  const samples = (RATE * ms) / 1000
  const pcm = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) {
    pcm.writeInt16LE(Math.round(4_600 * Math.sin((2 * Math.PI * 220 * i) / RATE)), i * 2)
  }
  return pcm
}

const silence = (ms: number): Buffer => Buffer.alloc(((RATE * ms) / 1000) * 2)

/** 一句话：前面静一下（攒底噪）、说 600 毫秒 */
const sentence = (): Buffer => Buffer.concat([silence(300), tone(600)])

const fetchMock = vi.fn<typeof fetch>()

function reply(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
}

/** 按采集节奏送进会话（base64，200 毫秒一包） */
function send(session: ReturnType<typeof openTranscriptionSttSession>, pcm: Buffer): void {
  const packet = 200 * 32
  for (let offset = 0; offset < pcm.length; offset += packet) {
    session.appendAudio(pcm.subarray(offset, offset + packet).toString('base64'))
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('认地址', () => {
  it('填到 /v1 为止的，补上 /audio/transcriptions', () => {
    expect(resolveTranscriptionTarget('http://127.0.0.1:8000/v1/')).toEqual({
      url: 'http://127.0.0.1:8000/v1/audio/transcriptions',
      api: 'openai'
    })
  })

  it('直接贴了完整接口地址的，原样用', () => {
    expect(
      resolveTranscriptionTarget('https://api.siliconflow.cn/v1/audio/transcriptions')
    ).toEqual({ url: 'https://api.siliconflow.cn/v1/audio/transcriptions', api: 'openai' })
  })

  it('SenseVoice 自带服务的 /api/v1/asr 认成它自己那一种', () => {
    expect(resolveTranscriptionTarget('http://127.0.0.1:50000/api/v1/asr')).toEqual({
      url: 'http://127.0.0.1:50000/api/v1/asr',
      api: 'sensevoice'
    })
  })
})

describe('pcmToWav', () => {
  it('头部写对采样率和长度', () => {
    const wav = pcmToWav(Buffer.alloc(320), RATE)
    expect(wav.length).toBe(364)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt32LE(24)).toBe(RATE)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.readUInt32LE(40)).toBe(320)
  })
})

describe('回包', () => {
  it('SenseVoice 的标签去掉，正文留下', () => {
    expect(stripSenseVoiceTags('<|zh|><|NEUTRAL|><|Speech|><|withitn|>打开蓝图。')).toBe(
      '打开蓝图。'
    )
  })

  it('OpenAI 形状取 text，透传了标签的也去掉', () => {
    expect(parseTranscription('openai', { text: '<|zh|>你好' })).toEqual({
      text: '你好',
      tags: ['zh'],
      speech: true
    })
  })

  it('SenseVoice 自带服务取 raw_text（text 被它换成了表情符号）', () => {
    expect(
      parseTranscription('sensevoice', {
        result: [{ raw_text: '<|zh|><|HAPPY|><|Speech|><|withitn|>好的。', text: '好的。😊' }]
      })
    ).toMatchObject({ text: '好的。', tags: ['zh', 'HAPPY', 'Speech', 'withitn'] })
    // 没听出东西时它回空数组
    expect(parseTranscription('sensevoice', { result: [] })).toMatchObject({ text: '' })
  })

  it('形状不对就抛，不把网页当成识别结果', () => {
    expect(() => parseTranscription('openai', { data: [] })).toThrow(/text/)
    expect(() => parseTranscription('sensevoice', { text: 'x' })).toThrow(/result/)
  })
})

describe('transcribePcm', () => {
  const config = { apiKey: 'sk', baseUrl: 'http://127.0.0.1:8000/v1', model: 'SenseVoiceSmall' }

  it('OpenAI 形状：file + model，带密钥', async () => {
    fetchMock.mockResolvedValue(reply({ text: '你好' }))
    const result = await transcribePcm(config, silence(100), RATE, new AbortController().signal)
    expect(result.text).toBe('你好')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:8000/v1/audio/transcriptions')
    const form = init?.body as FormData
    expect(form.get('model')).toBe('SenseVoiceSmall')
    expect((form.get('file') as File).type).toBe('audio/wav')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk')
  })

  it('本机服务没填密钥：不带 Authorization', async () => {
    fetchMock.mockResolvedValue(reply({ text: '' }))
    await transcribePcm({ ...config, apiKey: '' }, silence(100), RATE, new AbortController().signal)
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers).not.toHaveProperty('Authorization')
  })

  it('SenseVoice 自带服务：files + lang，打开文本规整', async () => {
    fetchMock.mockResolvedValue(reply({ result: [{ raw_text: '<|zh|>好' }] }))
    const text = await transcribePcm(
      { ...config, baseUrl: 'http://127.0.0.1:50000/api/v1/asr' },
      silence(100),
      RATE,
      new AbortController().signal
    )
    expect(text.text).toBe('好')
    const form = fetchMock.mock.calls[0][1]?.body as FormData
    expect(form.get('files')).toBeInstanceOf(Blob)
    expect(form.get('lang')).toBe('auto')
    expect(form.get('use_itn')).toBe('true')
    expect(form.has('model')).toBe(false)
  })

  it('密钥不对：说是密钥的事，带上厂商原话', async () => {
    fetchMock.mockResolvedValue(reply({ error: { message: 'Invalid token' } }, 401))
    await expect(
      transcribePcm(config, silence(100), RATE, new AbortController().signal)
    ).rejects.toThrow(/拒绝了密钥.*Invalid token/)
  })

  it('地址不对：告诉用户该填到哪一层', async () => {
    fetchMock.mockResolvedValue(reply({ detail: 'Not Found' }, 404))
    await expect(
      transcribePcm(config, silence(100), RATE, new AbortController().signal)
    ).rejects.toThrow(/\/v1 为止/)
  })

  it('服务没开：说连不上，不甩一句 fetch failed', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    )
    await expect(
      transcribePcm(config, silence(100), RATE, new AbortController().signal)
    ).rejects.toThrow(/连不上.*正在运行/)
  })

  it('回的不是 JSON（地址填到了网页上）：明说', async () => {
    fetchMock.mockResolvedValue(reply('<html></html>'))
    await expect(
      transcribePcm(config, silence(100), RATE, new AbortController().signal)
    ).rejects.toThrow(/不是 JSON/)
  })
})

describe('probeTranscription', () => {
  it('真送一段静音过去：密钥、地址、模型名错了都在这一步暴露', async () => {
    fetchMock.mockResolvedValue(reply({ text: '' }))
    await probeTranscription(
      { apiKey: '', baseUrl: 'http://127.0.0.1:8000/v1', model: 'm' },
      AbortSignal.timeout(5_000)
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const file = (fetchMock.mock.calls[0][1]?.body as FormData).get('file') as File
    expect(file.size).toBeGreaterThan(44)
  })
})

describe('会话', () => {
  function open(): { session: ReturnType<typeof openTranscriptionSttSession>; events: SttEvent[] } {
    const events: SttEvent[] = []
    const session = openTranscriptionSttSession({
      apiKey: '',
      baseUrl: 'http://127.0.0.1:8000/v1',
      model: 'm',
      onEvent: (event) => events.push(event)
    })
    return { session, events }
  }

  /**
   * IPC 那头要等开会话的函数返回、把它记成当前这一路之后才转发事件。
   * 同步报的就绪会被当成别人的丢掉，渲染层永远等不到。
   */
  it('就绪不同步报，下一拍才报', async () => {
    const { events } = open()
    expect(events).toEqual([])
    await tick()
    expect(events).toEqual([{ type: 'ready' }])
  })

  it('说一句、停下来：这一句送去识别，回来一条终稿', async () => {
    fetchMock.mockResolvedValue(reply({ text: '打开关卡' }))
    const { session, events } = open()
    await tick()
    send(session, Buffer.concat([sentence(), silence(1_000)]))
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ final: true })))
    expect(events).toEqual([
      { type: 'ready' },
      { type: 'user-text', text: '打开关卡', final: true }
    ])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('一直没说话：一次请求都不发', async () => {
    const { session, events } = open()
    await tick()
    send(session, silence(3_000))
    session.flush()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(events.at(-1)).toEqual({ type: 'closed' })
  })

  it('松手：正在说的那句不等静音，识别完再收摊', async () => {
    fetchMock.mockResolvedValue(reply({ text: '保存' }))
    const { session, events } = open()
    await tick()
    send(session, sentence())
    session.flush()
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: 'closed' }))
    expect(events).toEqual([
      { type: 'ready' },
      { type: 'user-text', text: '保存', final: true },
      { type: 'closed' }
    ])
  })

  it('有人说话却没识别出字：报没听清，不掐会话', async () => {
    fetchMock.mockResolvedValue(reply({ text: '  ' }))
    const { session, events } = open()
    await tick()
    send(session, Buffer.concat([sentence(), silence(1_000)]))
    await vi.waitFor(() => expect(events).toContainEqual({ type: 'asr-failed' }))
    expect(events).not.toContainEqual({ type: 'closed' })
  })

  it('前一句识别得慢，后一句先回来：照说话的顺序出字', async () => {
    let releaseFirst: (() => void) | null = null
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve(reply({ text: '第一句' }))
          })
      )
      .mockResolvedValueOnce(reply({ text: '第二句' }))
    const { session, events } = open()
    await tick()
    send(session, Buffer.concat([sentence(), silence(1_000), sentence(), silence(1_000)]))
    await tick()
    releaseFirst!()
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === 'user-text')).toHaveLength(2)
    )
    expect(events.filter((event) => event.type === 'user-text').map((event) => event.text)).toEqual(
      ['第一句', '第二句']
    )
  })

  it('识别服务报错：把原话交出去，然后收摊', async () => {
    fetchMock.mockResolvedValue(reply({ error: { message: 'model not found' } }, 400))
    const { session, events } = open()
    await tick()
    send(session, Buffer.concat([sentence(), silence(1_000)]))
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: 'closed' }))
    expect(events).toContainEqual({
      type: 'error',
      message: expect.stringContaining('model not found')
    })
  })

  it('关掉：在路上的请求撤掉，之后什么都不再报', async () => {
    let signal: AbortSignal | undefined
    fetchMock.mockImplementation((_url, init) => {
      signal = init?.signal ?? undefined
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal?.reason))
      })
    })
    const { session, events } = open()
    await tick()
    send(session, Buffer.concat([sentence(), silence(1_000)]))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    session.close()
    await tick()
    expect(signal?.aborted).toBe(true)
    expect(events).toEqual([{ type: 'ready' }, { type: 'closed' }])
  })
})

/** 本机 SenseVoice 一键包的接口清单（照真机 /gradio_api/info 摘的） */
const GRADIO_INFO = {
  named_endpoints: {
    '/load_example': {
      parameters: [{ component: 'Dataset', parameter_has_default: false }],
      returns: [{ component: 'Audio' }, { component: 'Dropdown' }]
    },
    '/transcribe': {
      parameters: [
        { component: 'Audio', parameter_has_default: false },
        { component: 'Dropdown', parameter_has_default: true, parameter_default: 'auto' },
        { component: 'Checkbox', parameter_has_default: true, parameter_default: true }
      ],
      returns: [{ component: 'Textbox' }, { component: 'Textbox' }, { component: 'Textbox' }]
    }
  }
}

describe('Gradio 网页界面', () => {
  it('浏览器里打开的裸地址、/gradio_api、完整的 call 地址都认成 Gradio', () => {
    expect(resolveTranscriptionTarget('http://127.0.0.1:7860/')).toEqual({
      url: 'http://127.0.0.1:7860',
      api: 'gradio'
    })
    expect(resolveTranscriptionTarget('http://127.0.0.1:7860/gradio_api')).toEqual({
      url: 'http://127.0.0.1:7860',
      api: 'gradio'
    })
    expect(resolveTranscriptionTarget('http://127.0.0.1:7860/gradio_api/call/transcribe')).toEqual({
      url: 'http://127.0.0.1:7860',
      api: 'gradio',
      endpoint: 'transcribe'
    })
  })

  it('照接口清单填参数：音频放进音频那一格，其余用界面的默认值，结果取第一个文本框', () => {
    expect(planGradioCall(GRADIO_INFO)).toEqual({
      endpoint: 'transcribe',
      audioIndex: 0,
      defaults: [null, 'auto', true],
      outputIndex: 0
    })
  })

  it('官方 webui 的接口名是 model_inference、只有两个参数，也对得上', () => {
    const plan = planGradioCall({
      named_endpoints: {
        '/model_inference': {
          parameters: [
            { component: 'Audio', parameter_has_default: false },
            { component: 'Dropdown', parameter_has_default: true, parameter_default: 'auto' }
          ],
          returns: [{ component: 'Textbox' }]
        }
      }
    })
    expect(plan).toMatchObject({ endpoint: 'model_inference', defaults: [null, 'auto'] })
  })

  it('不是 Gradio、或者没有带音频的接口：明说', () => {
    expect(() => planGradioCall({ detail: 'Not Found' })).toThrow(/不是 Gradio/)
    expect(() => planGradioCall(GRADIO_INFO, 'nope')).toThrow(/没有 nope/)
    expect(() =>
      planGradioCall({ named_endpoints: { '/chat': { parameters: [{ component: 'Textbox' }] } } })
    ).toThrow(/没有带音频输入/)
  })

  it('事件流：取 complete 那一条；error 带上原话，null 不念', () => {
    expect(parseGradioEvents('event: complete\ndata: ["你好。", "状态"]\n\n')).toEqual([
      '你好。',
      '状态'
    ])
    expect(() => parseGradioEvents('event: error\ndata: null\n\n')).toThrow(/^Gradio 接口报错$/)
    expect(() => parseGradioEvents('event: error\ndata: "显存不足"\n\n')).toThrow(/显存不足/)
    expect(() => parseGradioEvents('')).toThrow(/没有返回结果/)
  })

  it('一次识别：读清单 → 传文件 → 发起 → 取结果；清单读一次就记住', async () => {
    const base = 'http://127.0.0.1:7861'
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/gradio_api/info')) return reply(GRADIO_INFO)
      if (url.endsWith('/gradio_api/upload')) return reply(['I:\\cache\\speech.wav'])
      if (url.endsWith('/gradio_api/call/transcribe')) return reply({ event_id: 'e1' })
      if (url.endsWith('/gradio_api/call/transcribe/e1')) {
        return reply(
          'event: complete\ndata: ["打开角色蓝图。😊", "音频 2.3 秒", "<|zh|>打开角色蓝图。"]\n\n'
        )
      }
      return reply('', 404)
    })
    const config = { apiKey: '', baseUrl: base, model: 'm' }
    const signal = new AbortController().signal
    // 识别结果那一栏是干净文字，标签从「原始输出」那一栏读
    await expect(transcribePcm(config, silence(100), RATE, signal)).resolves.toEqual({
      text: '打开角色蓝图。',
      tags: ['zh'],
      speech: true
    })

    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/call/transcribe'))!
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      data: [
        {
          path: 'I:\\cache\\speech.wav',
          orig_name: 'speech.wav',
          meta: { _type: 'gradio.FileData' }
        },
        'auto',
        true
      ]
    })
    const upload = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/upload'))!
    expect((upload[1]?.body as FormData).get('files')).toBeInstanceOf(Blob)

    await transcribePcm(config, silence(100), RATE, signal)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/info'))).toHaveLength(1)
  })

  it('清单没读到（服务刚开）：不记住失败，下一句再读', async () => {
    const base = 'http://127.0.0.1:7862'
    fetchMock.mockResolvedValueOnce(reply('', 502))
    const config = { apiKey: '', baseUrl: base, model: 'm' }
    await expect(
      transcribePcm(config, silence(100), RATE, new AbortController().signal)
    ).rejects.toThrow(/HTTP 502/)
    fetchMock.mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/info')) return reply(GRADIO_INFO)
      if (url.endsWith('/upload')) return reply(['p'])
      if (url.endsWith('/call/transcribe')) return reply({ event_id: 'e2' })
      return reply('event: complete\ndata: ["好"]\n\n')
    })
    await expect(
      transcribePcm(config, silence(100), RATE, new AbortController().signal)
    ).resolves.toMatchObject({ text: '好' })
  })
})

describe('SenseVoice 的表情', () => {
  it('官方后处理换成的情绪、事件表情去掉，正文留下', () => {
    expect(stripSenseVoiceTags('🎼好的，保存关卡。😊')).toBe('好的，保存关卡。')
    expect(stripSenseVoiceTags('❓')).toBe('')
  })
})

/**
 * 是不是人声由识别模型说了算：SenseVoice 对杂音会打 nospeech、或者只回一个标点。
 * 这种当没发生 —— 拼装通话里不上屏、不打断；听写里也不该说「没听清」。
 */
describe('识别模型说不是人声的', () => {
  it('nospeech 标签、只剩标点的，都不算人声', () => {
    expect(readTranscript('<|nospeech|><|EMO_UNKNOWN|><|Event_UNK|><|woitn|>')).toEqual({
      text: '',
      tags: ['nospeech', 'EMO_UNKNOWN', 'Event_UNK', 'woitn'],
      speech: false
    })
    expect(readTranscript('<|en|><|NEUTRAL|><|Speech|><|woitn|>.')).toMatchObject({
      text: '',
      speech: false
    })
    expect(readTranscript('❓')).toMatchObject({ speech: false })
  })

  it('会话里：不是人声的一段不上屏、也不报没听清；是人声的带上标签', async () => {
    fetchMock
      .mockResolvedValueOnce(reply({ text: '<|en|><|NEUTRAL|><|Speech|><|woitn|>.' }))
      .mockResolvedValueOnce(reply({ text: '<|zh|><|NEUTRAL|><|Speech|><|withitn|>保存关卡。' }))
    const events: SttEvent[] = []
    const session = openTranscriptionSttSession({
      apiKey: '',
      baseUrl: 'http://127.0.0.1:8000/v1',
      model: 'm',
      onEvent: (event) => events.push(event)
    })
    await tick()
    send(session, Buffer.concat([sentence(), silence(1_000), sentence(), silence(1_000)]))
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'user-text')).toHaveLength(1))
    expect(events).not.toContainEqual({ type: 'asr-failed' })
    expect(events).toContainEqual({
      type: 'user-text',
      text: '保存关卡。',
      final: true,
      asrTags: ['zh', 'NEUTRAL', 'Speech', 'withitn']
    })
  })
})
