import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf-8')
  }
}))

const settings = {
  version: 3 as const,
  providers: [
    {
      id: 'ark-seedance',
      displayName: '火山方舟 Seedance',
      kind: 'video',
      videoApi: 'ark-video' as string | undefined,
      protocol: 'openai-completions',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      apiKey: { kind: 'none' } as { kind: 'none' },
      headers: { 'User-Agent': 'unreal-box' },
      models: [{ id: 'doubao-seedance-2-5-260628' }]
    }
  ],
  roles: {} as Record<string, { providerId: string; modelId: string }>
}

vi.mock('./store', () => ({ readSettings: async () => settings }))

const {
  submitVideo,
  pollVideo,
  generateVideo,
  getVideoStatus,
  VideoApiUnknownError,
  VideoEmptyPromptError,
  VideoJobFailedError,
  VideoPayloadTooLargeError,
  VideoParamUnsupportedError,
  VideoRequestError
} = await import('./video')

type Provider = Parameters<typeof submitVideo>[0]

interface SentRequest {
  url: string
  method: string
  json: Record<string, unknown>
}

let sent: SentRequest[] = []
let responders: Record<string, () => Response>

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
}

function stubFetch(): void {
  vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
    const url = String(input)
    sent.push({
      url,
      method: init.method ?? 'POST',
      json: typeof init.body === 'string' ? JSON.parse(init.body) : {}
    })
    // 去掉各家 Base URL 自带的路径前缀，键里只留适配器自己拼的那一段
    const path = new URL(url).pathname.replace(/^\/api\/v3|^\/v2/, '')
    const key = `${init.method ?? 'POST'} ${path}`
    const respond = Object.entries(responders)
      .filter(([prefix]) => key.startsWith(prefix))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1]
    return respond ? respond() : jsonResponse({})
  })
}

const provider = (): Provider => settings.providers[0] as unknown as Provider

function requestAt(suffix: string): SentRequest {
  const found = sent.filter((item) => new URL(item.url).pathname.includes(suffix))
  expect(found.length, `没有请求打到 ${suffix}`).toBeGreaterThan(0)
  return found[found.length - 1]
}

/** 切到 MiniMax：改 Provider 上的形状与地址，模型清单跟着换 */
function useMinimax(): void {
  settings.providers[0].videoApi = 'minimax-video'
  settings.providers[0].baseUrl = 'https://api.minimaxi.com/v2'
  settings.providers[0].models = [{ id: 'MiniMax-H3' }]
  settings.roles = { video: { providerId: 'ark-seedance', modelId: 'MiniMax-H3' } }
}

beforeEach(() => {
  settings.providers[0].videoApi = 'ark-video'
  settings.providers[0].baseUrl = 'https://ark.cn-beijing.volces.com/api/v3'
  settings.providers[0].models = [{ id: 'doubao-seedance-2-5-260628' }]
  settings.roles = {
    video: { providerId: 'ark-seedance', modelId: 'doubao-seedance-2-5-260628' }
  }
  sent = []
  responders = {
    'POST /contents/generations/tasks': () => jsonResponse({ id: 'cgt-20260414-abc' }),
    'GET /contents/generations/tasks': () =>
      jsonResponse({
        status: 'succeeded',
        content: { video_url: 'https://cdn/v.mp4' },
        usage: { total_tokens: 411300 }
      }),
    'POST /video_generation': () => jsonResponse({ task_id: '424010985738629' }),
    'GET /query/video_generation': () =>
      jsonResponse({ task: { status: 'succeeded', content: { url: 'https://cdn/mm.mp4' } } })
  }
  vi.unstubAllGlobals()
  vi.useRealTimers()
  stubFetch()
})

describe('方舟 Seedance', () => {
  it('打在 Provider 的 Base URL 上，标量参数走顶层字段而不是拼进提示词', async () => {
    await submitVideo(provider(), 'doubao-seedance-2-5-260628', {
      prompt: '一只猫跳上桌子',
      resolution: '1080p',
      duration: 10,
      ratio: '16:9',
      audio: true,
      seed: 42
    })

    const request = requestAt('/contents/generations/tasks')
    expect(request.url).toBe('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks')
    expect(request.json).toEqual({
      model: 'doubao-seedance-2-5-260628',
      content: [{ type: 'text', text: '一只猫跳上桌子' }],
      resolution: '1080p',
      duration: 10,
      ratio: '16:9',
      generate_audio: true,
      seed: 42
    })
  })

  it('参考图进 content 数组，带上 reference_image 这个 role', async () => {
    await submitVideo(provider(), 'doubao-seedance-2-5-260628', {
      prompt: '广告片',
      images: [{ url: 'https://cdn/ref.png', role: 'reference' }]
    })

    expect(requestAt('/contents/generations/tasks').json.content).toEqual([
      { type: 'text', text: '广告片' },
      { type: 'image_url', image_url: { url: 'https://cdn/ref.png' }, role: 'reference_image' }
    ])
  })

  it('任务号在顶层 id，轮询打 GET 同一条路径', async () => {
    const job = await submitVideo(provider(), 'doubao-seedance-2-5-260628', { prompt: '猫' })
    // 任务号里带上厂商，续跑时才不会拿方舟的号去问 MiniMax
    expect(job).toEqual({ id: 'cgt-20260414-abc', providerId: 'ark-seedance' })

    const progress = await pollVideo(provider(), job)
    const poll = requestAt('/contents/generations/tasks/cgt-20260414-abc')
    expect(poll.method).toBe('GET')
    expect(progress.done).toBe(true)
    expect(progress.url).toBe('https://cdn/v.mp4')
    expect(progress.usage).toBe(411300)
  })

  it('参考视频与参考音频带各自的 type 和 role 进 content 数组', async () => {
    await submitVideo(provider(), 'doubao-seedance-2-5-260628', {
      prompt: '参考视频 1 的运镜',
      images: [{ url: 'https://cdn/ref.png', role: 'reference' }],
      videos: ['https://cdn/cam.mp4'],
      audios: ['data:audio/mp3;base64,AAAA', 'asset://asset-123']
    })

    expect(requestAt('/contents/generations/tasks').json.content).toEqual([
      { type: 'text', text: '参考视频 1 的运镜' },
      { type: 'image_url', image_url: { url: 'https://cdn/ref.png' }, role: 'reference_image' },
      { type: 'video_url', video_url: { url: 'https://cdn/cam.mp4' }, role: 'reference_video' },
      {
        type: 'audio_url',
        audio_url: { url: 'data:audio/mp3;base64,AAAA' },
        role: 'reference_audio'
      },
      { type: 'audio_url', audio_url: { url: 'asset://asset-123' }, role: 'reference_audio' }
    ])
  })

  /** 方舟不收视频的 base64。放过去是厂商几十秒后回的一句 400 */
  it('参考视频不是直链也不是 asset:// 时本地拦掉', async () => {
    for (const url of ['C:/clips/a.avi', 'data:video/mp4;base64,AAAA']) {
      await expect(
        submitVideo(provider(), 'doubao-seedance-2-5-260628', { prompt: '猫', videos: [url] })
      ).rejects.toThrow(/参考视频/)
    }
    await expect(
      submitVideo(provider(), 'doubao-seedance-2-5-260628', {
        prompt: '猫',
        audios: ['C:/a.mp3']
      })
    ).rejects.toThrow(/参考音频/)
    expect(sent).toHaveLength(0)
  })

  /** 首帧、首尾帧、全模态参考是方舟的三种互斥场景，混发要等排完队才异步报错 */
  it('首帧和参考素材混用时本地拦掉', async () => {
    await expect(
      submitVideo(provider(), 'doubao-seedance-2-5-260628', {
        prompt: '猫',
        images: [{ url: 'https://cdn/a.png', role: 'first_frame' }],
        videos: ['https://cdn/cam.mp4']
      })
    ).rejects.toThrow(VideoParamUnsupportedError)
    await expect(
      submitVideo(provider(), 'doubao-seedance-2-5-260628', {
        prompt: '猫',
        images: [
          { url: 'https://cdn/a.png', role: 'first_frame' },
          { url: 'https://cdn/b.png', role: 'reference' }
        ]
      })
    ).rejects.toThrow(VideoParamUnsupportedError)
    expect(sent).toHaveLength(0)
  })

  /** 方舟最高 1080p。静默降级的话用户付了 2K 的预期、拿到 1080p 的片子 */
  it('要 2K 时明确报错，而不是悄悄降到 1080p', async () => {
    await expect(
      submitVideo(provider(), 'doubao-seedance-2-5-260628', { prompt: '猫', resolution: '2k' })
    ).rejects.toThrow(VideoParamUnsupportedError)
    expect(sent).toHaveLength(0)
  })
})

describe('MiniMax v2', () => {
  beforeEach(useMinimax)

  /**
   * 与方舟三处不同，每一处踩错都是一次失败：任务号叫 task_id、轮询响应多包一层
   * task、resolution 与 duration 是必填。照着方舟写过来就是一次 422。
   */
  it('resolution 与 duration 是必填，没给也要补上缺省', async () => {
    await submitVideo(provider(), 'MiniMax-H3', { prompt: '一只猫' })

    expect(requestAt('/video_generation').json).toEqual({
      model: 'MiniMax-H3',
      content: [{ type: 'text', text: '一只猫' }],
      resolution: '768P',
      duration: 5,
      // 文生视频时 ratio 必填且不能是 adaptive
      ratio: '16:9'
    })
  })

  it('720p 翻成它自己的 768P —— 它没有 720P 这一档', async () => {
    await submitVideo(provider(), 'MiniMax-H3', { prompt: '猫', resolution: '720p', duration: 8 })
    expect(requestAt('/video_generation').json.resolution).toBe('768P')
  })

  it('有参考图时不发 ratio —— 那种情况厂商按图定，发了也被忽略', async () => {
    await submitVideo(provider(), 'MiniMax-H3', {
      prompt: '猫',
      images: [{ url: 'https://cdn/a.png' }]
    })

    const body = requestAt('/video_generation').json
    expect(body.ratio).toBeUndefined()
    // role 不给时按首帧处理，这是 MiniMax 文档里的缺省
    expect(body.content).toEqual([
      { type: 'text', text: '猫' },
      { type: 'image_url', image_url: { url: 'https://cdn/a.png' }, role: 'first_frame' }
    ])
  })

  it('任务号叫 task_id，轮询响应多包一层 task', async () => {
    const job = await submitVideo(provider(), 'MiniMax-H3', { prompt: '猫' })
    expect(job).toEqual({ id: '424010985738629', providerId: 'ark-seedance' })

    const progress = await pollVideo(provider(), job)
    expect(requestAt('/query/video_generation/424010985738629').method).toBe('GET')
    expect(progress.done).toBe(true)
    expect(progress.url).toBe('https://cdn/mm.mp4')
  })

  it('没有参考视频/音频入参，给了就报错而不是静默丢掉', async () => {
    useMinimax()
    await expect(
      submitVideo(provider(), 'MiniMax-H3', { prompt: '猫', videos: ['https://cdn/cam.mp4'] })
    ).rejects.toThrow(VideoParamUnsupportedError)
    expect(sent).toHaveLength(0)
  })

  it('没有有声开关，给了就报错而不是静默忽略', async () => {
    await expect(
      submitVideo(provider(), 'MiniMax-H3', { prompt: '猫', audio: true })
    ).rejects.toThrow(VideoParamUnsupportedError)
  })
})

describe('两家共同的前置检查', () => {
  it('没有提示词时本地就拦掉，不发请求', async () => {
    await expect(submitVideo(provider(), 'x', { prompt: '   ' })).rejects.toThrow(
      VideoEmptyPromptError
    )
    expect(sent).toHaveLength(0)
  })

  /**
   * 两家**都收 base64**（方舟文档明写 `data:image/<格式>;base64,<编码>`，
   * MiniMax 只是建议大文件走直链）。这一条守的是「别再把它们拒掉」——
   * 拒掉的代价是「白盒截图 → 生成视频」这条主线路整个走不通。
   */
  it('data URI 的参考图照常发出去，不再被当成不支持', async () => {
    await submitVideo(provider(), 'doubao-seedance-2-5-260628', {
      prompt: '猫',
      images: [{ url: 'data:image/png;base64,aGk=', role: 'reference' }]
    })

    expect(requestAt('/contents/generations/tasks').json.content).toEqual([
      { type: 'text', text: '猫' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,aGk=' },
        role: 'reference_image'
      }
    ])
  })

  it('既不是直链也不是 data URI 的（比如本地路径）明确报错', async () => {
    await expect(
      submitVideo(provider(), 'x', { prompt: '猫', images: [{ url: 'C:/shots/a.png' }] })
    ).rejects.toThrow(/既不是公网直链也不是 data URI/)
    expect(sent).toHaveLength(0)
  })

  /**
   * base64 撑到 4/3，超了是一次 413 —— 而 413 在界面上只表现为「生成失败」，
   * 没人猜得到问题出在参考图上。所以在本地先算一遍。
   */
  it('内联参考图总量超过请求体上限时本地拦掉，不白发一次 413', async () => {
    const huge = `data:image/png;base64,${'A'.repeat(70 * 1024 * 1024)}`

    await expect(
      submitVideo(provider(), 'x', { prompt: '猫', images: [{ url: huge }] })
    ).rejects.toThrow(VideoPayloadTooLargeError)
    expect(sent).toHaveLength(0)
  })

  it('公网直链不计入那个额度 —— 它在请求体里只是个地址', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ url: `https://cdn/${i}.png` }))

    await submitVideo(provider(), 'doubao-seedance-2-5-260628', { prompt: '猫', images: many })

    expect(sent.length).toBeGreaterThan(0)
  })

  it('Provider 没写 videoApi 就报错，不猜一个缺省值', async () => {
    settings.providers[0].videoApi = undefined
    await expect(submitVideo(provider(), 'x', { prompt: '猫' })).rejects.toThrow(
      VideoApiUnknownError
    )
    expect(sent).toHaveLength(0)
  })

  it('厂商打回请求时带上状态码与厂商那句话', async () => {
    responders['POST /contents/generations/tasks'] = () =>
      new Response(JSON.stringify({ error: { message: 'quota exhausted' } }), { status: 429 })

    await expect(submitVideo(provider(), 'x', { prompt: '猫' })).rejects.toThrow(VideoRequestError)
  })

  /** MiniMax 把错误放在 base_resp.status_msg 里，不在 error 下 */
  it('认得出 MiniMax 那种放在 base_resp 里的错误消息', async () => {
    useMinimax()
    responders['POST /video_generation'] = () =>
      new Response(JSON.stringify({ base_resp: { status_msg: 'invalid api key' } }), {
        status: 401
      })

    await expect(submitVideo(provider(), 'MiniMax-H3', { prompt: '猫' })).rejects.toThrow(
      /invalid api key/
    )
  })
})

describe('串起来的 generateVideo', () => {
  it('走完两段并把用量带出来', async () => {
    vi.useFakeTimers()
    const promise = generateVideo({ prompt: '猫' })
    await vi.advanceTimersByTimeAsync(11_000)
    const result = await promise

    expect(result.url).toBe('https://cdn/v.mp4')
    expect(result.usage).toBe(411300)
    expect(result.job.id).toBe('cgt-20260414-abc')
  })

  it('任务失败时把厂商那句话带出来', async () => {
    responders['GET /contents/generations/tasks'] = () =>
      jsonResponse({ status: 'failed', error: { message: '内容审核未通过' } })
    vi.useFakeTimers()
    // 断言先挂上，否则 reject 先落地就成了未处理拒绝
    const settled = expect(generateVideo({ prompt: '猫' })).rejects.toThrow(/内容审核未通过/)
    await vi.advanceTimersByTimeAsync(11_000)
    await settled
  })

  it('cancelled 也算失败，不会一直轮询到超时', async () => {
    responders['GET /contents/generations/tasks'] = () => jsonResponse({ status: 'cancelled' })
    vi.useFakeTimers()
    const settled = expect(generateVideo({ prompt: '猫' })).rejects.toThrow(VideoJobFailedError)
    await vi.advanceTimersByTimeAsync(11_000)
    await settled
  })
})

describe('配置状态', () => {
  it('绑定齐全时报已配置', async () => {
    expect(await getVideoStatus()).toEqual({
      configured: true,
      model: '火山方舟 Seedance:doubao-seedance-2-5-260628'
    })
  })

  it('绑定在但 Provider 没写接口形状，等于没配', async () => {
    settings.providers[0].videoApi = undefined
    expect(await getVideoStatus()).toEqual({ configured: false, model: null })
  })

  it('没有绑定时报未配置', async () => {
    settings.roles = {}
    expect(await getVideoStatus()).toEqual({ configured: false, model: null })
  })
})
