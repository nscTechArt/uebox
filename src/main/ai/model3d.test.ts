import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf-8')
  }
}))

interface TestModel {
  id: string
}

const settings = {
  version: 1 as const,
  providers: [
    {
      id: 'hyper3d',
      displayName: 'Hyper3D',
      kind: 'model3d',
      model3dApi: 'rodin' as string | undefined,
      protocol: 'openai-completions',
      baseUrl: 'https://api.hyper3d.com/api/v2',
      apiKey: { kind: 'none' } as { kind: 'none' },
      headers: { 'User-Agent': 'unreal-box' },
      models: [{ id: 'Gen-2' }] as TestModel[]
    }
  ],
  roles: {} as Record<string, { providerId: string; modelId: string }>
}

vi.mock('./store', () => ({
  readSettings: async () => settings
}))

const {
  submitModel3d,
  pollModel3d,
  fetchModel3dFiles,
  generateModel3d,
  getModel3dStatus,
  Model3dApiUnknownError,
  Model3dEmptyInputError,
  Model3dJobFailedError,
  Model3dParamUnsupportedError,
  Model3dNoFilesError,
  Model3dRequestError,
  encodeModel3dJob,
  decodeModel3dJob
} = await import('./model3d')

type Provider = Parameters<typeof submitModel3d>[0]

interface SentRequest {
  url: string
  method: string
  headers: Record<string, string>
  form?: FormData
  json: Record<string, unknown>
}

let sent: SentRequest[] = []

/**
 * 每个端点回什么，由各用例自己覆盖。
 *
 * 键是 `「方法 路径前缀」`，按**最长前缀**匹配 —— 光靠路径分不开这两条：
 *   POST /openapi/v1/image-to-3d        创建任务
 *   GET  /openapi/v1/image-to-3d/{id}   查任务
 */
let responders: Record<string, () => Response>

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' }
  })
}

/** 官方文档里那份提交响应：三个 id，只有两个能用 */
const SUBMIT_OK = {
  error: null,
  message: 'Submitted.',
  uuid: 'task-uuid-for-download',
  jobs: { uuids: ['job-a'], subscription_key: 'sub-key-for-status' },
  consumed: 0.5
}

function stubFetch(): void {
  vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
    const url = String(input)
    const body = init.body
    sent.push({
      url,
      method: init.method ?? 'POST',
      headers: (init.headers as Record<string, string>) ?? {},
      form: body instanceof FormData ? body : undefined,
      json: typeof body === 'string' ? JSON.parse(body) : {}
    })
    // 去掉 Provider 的 Base URL 路径，键里只留适配器自己拼的那一段
    const path = new URL(url).pathname.replace('/api/v2', '')
    const key = `${init.method ?? 'POST'} ${path}`
    const respond = Object.entries(responders)
      .filter(([prefix]) => key.startsWith(prefix))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1]
    return respond ? respond() : jsonResponse({})
  })
}

const provider = (): Provider => settings.providers[0] as unknown as Provider

function requestAt(suffix: string): SentRequest {
  const found = sent.filter((item) => new URL(item.url).pathname.endsWith(suffix))
  expect(found.length, `没有请求打到 ${suffix}`).toBeGreaterThan(0)
  return found[found.length - 1]
}

beforeEach(() => {
  // 形状那一位在 Provider 上，每个用例都要复位 —— 否则改过它的那条会污染后面的
  settings.providers[0].model3dApi = 'rodin'
  settings.providers[0].models = [{ id: 'Gen-2' }]
  settings.roles = { model3d: { providerId: 'hyper3d', modelId: 'Gen-2' } }
  sent = []
  responders = {
    'POST /rodin': () => jsonResponse(SUBMIT_OK),
    'POST /status': () => jsonResponse({ jobs: [{ status: 'Done' }] }),
    'POST /download': () => jsonResponse({ list: [{ url: 'https://cdn/a.glb', name: 'a.glb' }] }),
    // 后两家的缺省：提交成功、任务已完成
    'POST /generation/': () => jsonResponse({ code: 0, data: { task_id: 'task-1' } }),
    'GET /tasks/': () =>
      jsonResponse({
        code: 0,
        data: { status: 'success', output: { model_url: 'https://cdn/a.glb' } }
      }),
    'POST /openapi/v1/': () => jsonResponse({ result: 'task-1' }),
    'GET /openapi/v1/': () =>
      jsonResponse({ status: 'SUCCEEDED', model_urls: { glb: 'https://cdn/a.glb' } })
  }
  vi.unstubAllGlobals()
  vi.useRealTimers()
  stubFetch()
})

describe('rodin 提交', () => {
  it('打在 Provider 的 Base URL 上，带附加请求头，且不手写 multipart 的 Content-Type', async () => {
    await submitModel3d(provider(), 'Gen-2', { prompt: '一把维京战斧' })

    const request = requestAt('/rodin')
    expect(request.url).toBe('https://api.hyper3d.com/api/v2/rodin')
    expect(request.headers['User-Agent']).toBe('unreal-box')
    // boundary 只有 fetch 自己知道，手补一个头会让厂商解不出任何字段
    expect(request.headers['Content-Type']).toBeUndefined()
    expect(request.form?.get('tier')).toBe('Gen-2')
    expect(request.form?.get('prompt')).toBe('一把维京战斧')
    // 没指定就不发，交给厂商用自己的缺省值
    expect(request.form?.get('quality')).toBeNull()
    expect(request.form?.get('mesh_mode')).toBeNull()
  })

  it('把档位翻成 Rodin 自己的写法，包围盒发成三个整数的 JSON', async () => {
    await submitModel3d(provider(), 'Gen-2', {
      prompt: '战斧',
      format: 'fbx',
      quality: 'extra-low',
      topology: 'quad',
      material: 'shaded',
      boundingBox: [30, 90, 10],
      seed: 42,
      restPose: true
    })

    const form = requestAt('/rodin').form!
    expect(form.get('geometry_file_format')).toBe('fbx')
    expect(form.get('quality')).toBe('extra-low')
    expect(form.get('mesh_mode')).toBe('Quad')
    expect(form.get('material')).toBe('Shaded')
    expect(form.get('bbox_condition')).toBe('[30,90,10]')
    expect(form.get('seed')).toBe('42')
    expect(form.get('TAPose')).toBe('true')
  })

  it('参考图取成字节上传，data URI 与裸 base64 都收', async () => {
    await submitModel3d(provider(), 'Gen-2', {
      images: ['data:image/jpeg;base64,/9j/4AAQ', 'aGVsbG8=']
    })

    const files = requestAt('/rodin').form!.getAll('images')
    expect(files).toHaveLength(2)
    expect((files[0] as File).type).toBe('image/jpeg')
    // 认不出媒体类型的一律按 png 走
    expect((files[1] as File).type).toBe('image/png')
  })

  /**
   * `Buffer.from(x, 'base64')` 会把字母表以外的字符丢掉再解剩下的，所以它对
   * **任何**字符串都「成功」。真机上被喂进来的是文件路径：路径里的字母正好
   * 都在 base64 字母表里，于是解出几个垃圾字节、不报错、照常提交 ——
   * 用户付了全款，换回一个凭空捏造的模型。
   */
  it.each([
    ['盘符路径', 'H:/shots/front.png'],
    ['反斜杠路径', 'C:\\shots\\front.png'],
    ['POSIX 绝对路径', '/tmp/shots/front.png'],
    ['相对路径', 'shots/front.png'],
    ['光秃秃的文件名', 'front.png']
  ])('%s 被当图片糊弄不过去，报错要说清「先读成图片内容」', async (_label, path) => {
    await expect(submitModel3d(provider(), 'Gen-2', { images: [path] })).rejects.toThrow(
      /文件路径.*data URI/s
    )
    expect(sent, '认不出来的输入不该发出去换一次收费的 400').toHaveLength(0)
  })

  it('不成形的裸字符串照旧拦掉，而不是解出几个垃圾字节', async () => {
    await expect(
      submitModel3d(provider(), 'Gen-2', { images: ['这不是图片，是一句话'] })
    ).rejects.toThrow(/既不是地址也不是可解析的 base64/)
    expect(sent).toHaveLength(0)
  })

  it('既没提示词也没参考图时本地就拦掉，不发请求', async () => {
    await expect(submitModel3d(provider(), 'Gen-2', { prompt: '   ' })).rejects.toThrow(
      Model3dEmptyInputError
    )
    expect(sent).toHaveLength(0)
  })

  it('Provider 没写 model3dApi 就报错，不猜一个缺省值', async () => {
    settings.providers[0].model3dApi = undefined
    await expect(submitModel3d(provider(), 'Gen-2', { prompt: '战斧' })).rejects.toThrow(
      Model3dApiUnknownError
    )
    expect(sent).toHaveLength(0)
  })

  it('厂商打回请求时带上状态码与厂商那句话', async () => {
    responders['POST /rodin'] = () =>
      new Response(JSON.stringify({ error: { message: 'insufficient credits' } }), { status: 402 })

    await expect(submitModel3d(provider(), 'Gen-2', { prompt: '战斧' })).rejects.toThrow(
      /HTTP 402.*insufficient credits/
    )
    await expect(submitModel3d(provider(), 'Gen-2', { prompt: '战斧' })).rejects.toThrow(
      Model3dRequestError
    )
  })
})

describe('两个任务号不能混用', () => {
  it('轮询用 subscription_key，下载用顶层 uuid', async () => {
    const job = await submitModel3d(provider(), 'Gen-2', { prompt: '战斧' })
    expect(job).toEqual({
      poll: 'sub-key-for-status',
      download: 'task-uuid-for-download',
      cost: 0.5,
      // 任务号里带上厂商，续跑时才不会拿 Tripo 的号去问 Rodin
      providerId: 'hyper3d'
    })

    await pollModel3d(provider(), job)
    await fetchModel3dFiles(provider(), job)

    // 这是官方文档专门加警告的那一脚：jobs.uuids 两处都不是
    expect(requestAt('/status').json).toEqual({ subscription_key: 'sub-key-for-status' })
    expect(requestAt('/download').json).toEqual({ task_uuid: 'task-uuid-for-download' })
  })

  it('响应里缺任一个 id 就报错，而不是拿着空串继续轮询', async () => {
    responders['POST /rodin'] = () => jsonResponse({ uuid: 'only-download', jobs: {} })
    await expect(submitModel3d(provider(), 'Gen-2', { prompt: '战斧' })).rejects.toThrow(
      /没有任务号/
    )
  })
})

describe('轮询进度', () => {
  const job = { poll: 'p', download: 'd', cost: null }

  it('多个子任务要全部 Done 才算完', async () => {
    responders['POST /status'] = () =>
      jsonResponse({ jobs: [{ status: 'Done' }, { status: 'Generating' }] })

    const progress = await pollModel3d(provider(), job)
    expect(progress).toEqual({ done: false, failed: false, note: '1/2 个子任务已完成' })
  })

  it('任一子任务 Failed 就是失败，不等其余的', async () => {
    responders['POST /status'] = () =>
      jsonResponse({ jobs: [{ status: 'Done' }, { status: 'Failed' }] })

    const progress = await pollModel3d(provider(), job)
    expect(progress.failed).toBe(true)
    expect(progress.done).toBe(false)
  })

  it('响应里没有 jobs 数组时按「还没好」处理，不误判成完成', async () => {
    responders['POST /status'] = () => jsonResponse({})
    expect(await pollModel3d(provider(), job)).toEqual({
      done: false,
      failed: false,
      note: ''
    })
  })
})

describe('取文件', () => {
  const job = { poll: 'p', download: 'd', cost: null }

  it.each([
    ['list 里的对象', { list: [{ url: 'https://cdn/x.glb', name: 'x.glb' }] }],
    ['files 里的对象', { files: [{ file_url: 'https://cdn/x.glb', file_name: 'x.glb' }] }],
    ['根就是数组', [{ download_url: 'https://cdn/x.glb', name: 'x.glb' }]],
    ['一串裸地址', { result: ['https://cdn/x.glb'] }]
  ])('%s 都能挖出地址', async (_label, payload) => {
    responders['POST /download'] = () => jsonResponse(payload)
    expect(await fetchModel3dFiles(provider(), job)).toEqual([
      { url: 'https://cdn/x.glb', name: 'x.glb' }
    ])
  })

  it('没有文件名时从地址末段取，并剥掉查询串', async () => {
    responders['POST /download'] = () =>
      jsonResponse({ list: ['https://cdn/a/b/hero.glb?sig=abc'] })
    expect((await fetchModel3dFiles(provider(), job))[0].name).toBe('hero.glb')
  })

  it('一个地址都挖不出来时报错，而不是静悄悄返回空数组', async () => {
    responders['POST /download'] = () => jsonResponse({ ok: true })
    await expect(fetchModel3dFiles(provider(), job)).rejects.toThrow(Model3dNoFilesError)
  })
})

describe('串起来的 generateModel3d', () => {
  it('走完三段并把额度带出来', async () => {
    vi.useFakeTimers()
    const promise = generateModel3d({ prompt: '战斧' })
    await vi.advanceTimersByTimeAsync(6000)
    const result = await promise

    expect(result.job.cost).toBe(0.5)
    expect(result.files).toEqual([{ url: 'https://cdn/a.glb', name: 'a.glb' }])
  })

  it('任务失败时不再去取文件', async () => {
    responders['POST /status'] = () => jsonResponse({ jobs: [{ status: 'Failed' }] })
    vi.useFakeTimers()
    // 断言要在推进定时器**之前**挂上，否则 reject 先落地就成了未处理拒绝
    const settled = expect(generateModel3d({ prompt: '战斧' })).rejects.toThrow(
      Model3dJobFailedError
    )
    await vi.advanceTimersByTimeAsync(6000)
    await settled

    expect(sent.some((item) => item.url.endsWith('/download'))).toBe(false)
  })
})

// ── 第二、三家 ────────────────────────────────────────────────────────────
//
// 这两家存在的意义不只是「多支持两家」：它们是**检验接口抽得对不对**的那两个
// 实现。只照 Rodin 一家写出来的接口，在这里被顶出了三个错 —— 轮询方法写死了
// POST、下载被当成必有的第三段、密钥前缀写死了 Bearer。

/** 把绑定换成指定的 api 与模型 id */
function useApi(api: string, modelId: string): void {
  settings.providers[0].model3dApi = api
  settings.providers[0].models = [{ id: modelId }]
  settings.roles = { model3d: { providerId: 'hyper3d', modelId } }
}

/**
 * Tripo 的 H 系列与 P 系列**共用同一条端点**，只靠 `model` 字段区分，
 * 但面数量级差 75 倍。用错表的表现是静默越界 —— 用户点了「主角道具精度」，
 * 拿回来一个两万面的东西，账照扣，要到进引擎才发现。
 */
describe('tripo 的两个系列', () => {
  it('H 系列按 H 表换算面数（到 15 万）', async () => {
    useApi('tripo', 'v3.1-20260211')
    await submitModel3d(provider(), 'v3.1-20260211', { prompt: '战斧', quality: 'high' })

    expect(requestAt('/generation/text-to-model').json.face_limit).toBe(150_000)
  })

  it('P 系列按 P 表换算，压在它 20,000 的硬上限以内', async () => {
    useApi('tripo', 'P1-20260311')
    await submitModel3d(provider(), 'P1-20260311', { prompt: '战斧', quality: 'high' })

    const limit = requestAt('/generation/text-to-model').json.face_limit as number
    expect(limit).toBe(20_000)
    expect(limit).toBeLessThanOrEqual(20_000)
  })

  it('P 系列最低档也不贴着 50 走 —— 文档说低于 150 面质量明显下降', async () => {
    useApi('tripo', 'P1-20260311')
    await submitModel3d(provider(), 'P1-20260311', { prompt: '战斧', quality: 'extra-low' })

    const limit = requestAt('/generation/text-to-model').json.face_limit as number
    expect(limit).toBeGreaterThanOrEqual(150)
    expect(limit).toBeLessThanOrEqual(20_000)
  })

  /** P 系列的参数表里根本没有 quad，发过去要么被忽略要么 400 */
  it('给 P 系列设四边面时明确报错，并指路 H 系列', async () => {
    useApi('tripo', 'P1-20260311')
    await expect(
      submitModel3d(provider(), 'P1-20260311', {
        prompt: '战斧',
        topology: 'quad',
        format: 'fbx'
      })
    ).rejects.toThrow(/P 系列/)
    expect(sent).toHaveLength(0)
  })

  it('P 系列的三角面拓扑照常提交，不发 quad 字段', async () => {
    useApi('tripo', 'P1-20260311')
    await submitModel3d(provider(), 'P1-20260311', { prompt: '战斧', topology: 'raw' })

    expect(requestAt('/generation/text-to-model').json).not.toHaveProperty('quad')
  })

  it('两个系列打的是同一条端点', async () => {
    useApi('tripo', 'P1-20260311')
    await submitModel3d(provider(), 'P1-20260311', { prompt: '战斧' })
    const pPath = new URL(requestAt('/generation/text-to-model').url).pathname

    sent.length = 0
    useApi('tripo', 'v3.1-20260211')
    await submitModel3d(provider(), 'v3.1-20260211', { prompt: '战斧' })

    expect(new URL(requestAt('/generation/text-to-model').url).pathname).toBe(pPath)
  })
})

describe('tripo 适配器（V3）', () => {
  beforeEach(() => useApi('tripo', 'v3.1-20260211'))

  it('文生与图生打不同端点，版本号发在 model 字段', async () => {
    await submitModel3d(provider(), 'v3.1-20260211', { prompt: '战斧' })

    const request = requestAt('/generation/text-to-model')
    expect(request.json).toMatchObject({ model: 'v3.1-20260211', prompt: '战斧' })
    // V2 管这个字段叫 model_version，V3 改了名；发错名字是一次静默的默认值
    expect(request.json.model_version).toBeUndefined()
  })

  it('轮询走 GET /tasks/{id}，不是 POST', async () => {
    responders['GET /tasks/'] = () =>
      jsonResponse({ code: 0, data: { status: 'running', progress: 42 } })
    const job = { poll: 'task_abc', download: 'text-to-model', cost: null }

    expect(await pollModel3d(provider(), job)).toEqual({
      done: false,
      failed: false,
      note: '42%',
      files: undefined
    })
    expect(requestAt('/tasks/task_abc').method).toBe('GET')
  })

  it('完成时文件直接从轮询响应里取，不再打第三段', async () => {
    responders['GET /tasks/'] = () =>
      jsonResponse({
        code: 0,
        data: {
          status: 'success',
          progress: 100,
          output: { model_url: 'https://cdn/a.glb', rendered_image_url: 'https://cdn/a.png' }
        }
      })
    const job = { poll: 'task_abc', download: 'text-to-model', cost: null }

    expect(await fetchModel3dFiles(provider(), job)).toEqual([
      { url: 'https://cdn/a.glb', name: 'a.glb' },
      { url: 'https://cdn/a.png', name: 'a.png' }
    ])
    // Rodin 才有 /download；给 Tripo 硬造一次就是造一个不存在的端点
    expect(sent.some((item) => item.url.includes('/download'))).toBe(false)
  })

  it('也认 V2 的旧输出字段 —— 用户可能还把地址指着旧版', async () => {
    responders['GET /tasks/'] = () =>
      jsonResponse({
        code: 0,
        data: { status: 'success', output: { pbr_model: 'https://cdn/x.glb' } }
      })
    const job = { poll: 't', download: 'text-to-model', cost: null }

    expect(await fetchModel3dFiles(provider(), job)).toEqual([
      { url: 'https://cdn/x.glb', name: 'x.glb' }
    ])
  })

  it('本地图片先传 /files 换 file_token，再把 token 当图片入参提交', async () => {
    responders['POST /files'] = () => jsonResponse({ code: 0, data: { file_token: 'file_abc123' } })
    responders['POST /generation/image-to-model'] = () =>
      jsonResponse({ code: 0, data: { task_id: 't1' } })

    await submitModel3d(provider(), 'v3.1-20260211', { images: ['data:image/png;base64,aGVsbG8='] })

    // multipart 的字段名是 file，Content-Type 交给 fetch 自己带 boundary
    const upload = requestAt('/files')
    expect(upload.form?.get('file')).toBeInstanceOf(File)
    expect(upload.headers['Content-Type']).toBeUndefined()
    // 换回来的 token 原样进 input，不是 base64、也不是文件名
    expect(requestAt('/generation/image-to-model').json.input).toBe('file_abc123')
  })

  it('上传回来没有 token 时报错，而不是把 undefined 当图片发出去', async () => {
    responders['POST /files'] = () => jsonResponse({ code: 0, data: {} })

    await expect(
      submitModel3d(provider(), 'v3.1-20260211', { images: ['data:image/png;base64,aGVsbG8='] })
    ).rejects.toThrow(/没有文件 token/)
    expect(sent.some((item) => item.url.includes('/generation/'))).toBe(false)
  })

  it('要 glb 却设了 quad 拓扑时报错 —— 那样拿到的会是一个正常完成的 fbx', async () => {
    await expect(
      submitModel3d(provider(), 'v3.1-20260211', { prompt: '战斧', topology: 'quad' })
    ).rejects.toThrow(Model3dParamUnsupportedError)
    expect(sent).toHaveLength(0)
  })

  it('quad + fbx 是自洽的，照常提交', async () => {
    await submitModel3d(provider(), 'v3.1-20260211', {
      prompt: '战斧',
      topology: 'quad',
      format: 'fbx'
    })
    expect(requestAt('/generation/text-to-model').json.quad).toBe(true)
  })

  it('包围盒不支持就报错，不静默丢掉 —— 丢了会正常出模型，只是尺寸不对', async () => {
    await expect(
      submitModel3d(provider(), 'v3.1-20260211', { prompt: '战斧', boundingBox: [30, 90, 10] })
    ).rejects.toThrow(Model3dParamUnsupportedError)
    expect(sent).toHaveLength(0)
  })

  it('公网直链的参考图照常提交', async () => {
    responders['POST /generation/image-to-model'] = () =>
      jsonResponse({ code: 0, data: { task_id: 't1' } })
    vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
      const url = String(input)
      // 参考图那一次是 GET 取字节，不进 sent
      if (url === 'https://pic/ref.png') {
        return new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } })
      }
      sent.push({
        url,
        method: init.method ?? 'POST',
        headers: (init.headers as Record<string, string>) ?? {},
        json: typeof init.body === 'string' ? JSON.parse(init.body) : {}
      })
      return jsonResponse({ code: 0, data: { task_id: 't1' } })
    })

    const job = await submitModel3d(provider(), 'v3.1-20260211', {
      images: ['https://pic/ref.png']
    })
    expect(requestAt('/generation/image-to-model').json.input).toBe('https://pic/ref.png')
    expect(job.poll).toBe('t1')
  })
})

/** 一张本地参考图。内容只用来区分是第几张，不需要是真的 png */
function localImage(tag: string): string {
  return `data:image/png;base64,${Buffer.from(tag).toString('base64')}`
}

/**
 * 多视图。
 *
 * `ai-3d-asset-production` skill 教用户先出一组互相一致的四视图再去生成，
 * 而**只有整组都到达厂商**那一步才有意义：只发第一张的话，四视图那笔钱白花了、
 * 背面仍旧是模型猜的，而且没有任何地方报错 —— 任务正常完成、正常扣费。
 */
describe('tripo 的多视图', () => {
  beforeEach(() => {
    useApi('tripo', 'v3.1-20260211')
    // 每张各换一个 token，好验出「整组都传上去了」而不是只传了第一张
    let uploads = 0
    responders['POST /files'] = () => {
      uploads += 1
      return jsonResponse({ code: 0, data: { file_token: `file_${uploads}` } })
    }
  })

  it('两张以上走 multiview-to-model，图片发在复数的 inputs 里', async () => {
    await submitModel3d(provider(), 'v3.1-20260211', {
      images: [localImage('front'), localImage('left')]
    })

    const request = requestAt('/generation/multiview-to-model')
    expect(request.json.inputs).toEqual([{ front: 'file_1' }, { left: 'file_2' }])
    // 单数的 input 是单图端点的入参，两个一起发会被打回
    expect(request.json).not.toHaveProperty('input')
    expect(request.json.model).toBe('v3.1-20260211')
  })

  /** 视位顺序要和 skill 里教的出图顺序对齐 —— 错位不报错，只是左右颠倒 */
  it('四张按 正面 → 左 → 背 → 右 落进四个视位', async () => {
    await submitModel3d(provider(), 'v3.1-20260211', {
      images: ['a', 'b', 'c', 'd'].map(localImage)
    })

    expect(requestAt('/generation/multiview-to-model').json.inputs).toEqual([
      { front: 'file_1' },
      { left: 'file_2' },
      { back: 'file_3' },
      { right: 'file_4' }
    ])
  })

  it('每张本地图各传一次 /files，不是只传第一张', async () => {
    await submitModel3d(provider(), 'v3.1-20260211', {
      images: ['a', 'b', 'c'].map(localImage)
    })

    expect(sent.filter((item) => item.url.endsWith('/files'))).toHaveLength(3)
  })

  it('只有一张时仍走单图端点的单数 input', async () => {
    await submitModel3d(provider(), 'v3.1-20260211', { images: [localImage('front')] })

    expect(requestAt('/generation/image-to-model').json.input).toBe('file_1')
    expect(sent.some((item) => item.url.includes('multiview'))).toBe(false)
  })

  /**
   * 第 5 张没有视位可放。静默丢掉的话用户以为五张都用上了，
   * 拿回来的其实是四张的结果 —— 与丢掉第 2–4 张是同一类错，只是更难看出来。
   */
  it('给第 5 张时明确报错，说清限制并指路 Rodin', async () => {
    const images = ['a', 'b', 'c', 'd', 'e'].map(localImage)

    await expect(submitModel3d(provider(), 'v3.1-20260211', { images })).rejects.toThrow(
      Model3dParamUnsupportedError
    )
    await expect(submitModel3d(provider(), 'v3.1-20260211', { images })).rejects.toThrow(
      /四个视位[\s\S]*Rodin/
    )
    // 换 token 那几次白发了（不花钱），但**提交**这一步没走出去
    expect(sent.some((item) => item.url.includes('/generation/'))).toBe(false)
  })

  it('任务类型跟着 job 存下来，轮询仍是统一的 /tasks/{id}', async () => {
    const job = await submitModel3d(provider(), 'v3.1-20260211', {
      images: [localImage('front'), localImage('left')]
    })
    expect(job.download).toBe('multiview-to-model')

    await pollModel3d(provider(), job)
    expect(requestAt(`/tasks/${job.poll}`).method).toBe('GET')
  })
})

/**
 * Meshy 的两个坑，都是**静默出错**那一类：
 * 文生是两步流程（只发第一步得到灰模），而 target_polycount / topology
 * 在 should_remesh 默认为 false 的型号上会被直接忽略。
 */
describe('meshy 的静默坑', () => {
  beforeEach(() => useApi('meshy', 'meshy-7'))

  it('纯文生明确拒绝，而不是发一步出灰模', async () => {
    await expect(submitModel3d(provider(), 'meshy-7', { prompt: '战斧' })).rejects.toThrow(
      /两步流程/
    )
    expect(sent).toHaveLength(0)
  })

  it('给了精度或拓扑就打开 should_remesh —— 否则那两个参数被静默忽略', async () => {
    await submitModel3d(provider(), 'meshy-7', {
      images: ['data:image/png;base64,aGk='],
      quality: 'low'
    })

    const body = requestAt('/openapi/v1/image-to-3d').json
    expect(body.should_remesh).toBe(true)
    expect(body.target_polycount).toBe(10_000)
  })

  it('没给精度也没给拓扑时不动 should_remesh，走厂商缺省', async () => {
    await submitModel3d(provider(), 'meshy-7', { images: ['data:image/png;base64,aGk='] })

    expect(requestAt('/openapi/v1/image-to-3d').json).not.toHaveProperty('should_remesh')
  })

  it('面数落在官方 remesh 区间 100–300,000 内', async () => {
    for (const quality of ['high', 'medium', 'low', 'extra-low'] as const) {
      sent.length = 0
      await submitModel3d(provider(), 'meshy-7', {
        images: ['data:image/png;base64,aGk='],
        quality
      })
      const count = requestAt('/openapi/v1/image-to-3d').json.target_polycount as number
      expect(count).toBeGreaterThanOrEqual(100)
      expect(count).toBeLessThanOrEqual(300_000)
    }
  })
})

describe('meshy 适配器', () => {
  beforeEach(() => useApi('meshy', 'meshy-7'))

  it('图生走 image-to-3d，参考图内联成 data URI', async () => {
    responders['POST /openapi/v1/image-to-3d'] = () => jsonResponse({ result: 'task-1' })
    const job = await submitModel3d(provider(), 'meshy-7', {
      images: ['data:image/png;base64,aGVsbG8='],
      quality: 'low'
    })

    const request = requestAt('/openapi/v1/image-to-3d')
    expect(request.json.ai_model).toBe('meshy-7')
    expect(String(request.json.image_url)).toMatch(/^data:image\/png;base64,/)
    expect(request.json.target_polycount).toBe(10_000)
    // 轮询端点按类型分叉，所以类型要跟着 job 存下来
    expect(job.download).toBe('image-to-3d')
  })

  /**
   * 这一条以前测的是「文生走 /openapi/v1/text-to-3d」—— 两处都错：
   * 文生在 **v2**（`/openapi/v2/text-to-3d`），而且是两步流程。
   * 现在文生被明确拒绝，轮询只剩图生这一条路。
   */
  it('轮询打回图生那条端点，任务类型跟着 job 存下来', async () => {
    const job = await submitModel3d(provider(), 'meshy-7', {
      images: ['data:image/png;base64,aGk=']
    })
    expect(job.download).toBe('image-to-3d')

    responders['GET /openapi/v1/image-to-3d/'] = () =>
      jsonResponse({ status: 'IN_PROGRESS', progress: 30 })
    await pollModel3d(provider(), job)
    expect(requestAt(`/openapi/v1/image-to-3d/${job.poll}`).method).toBe('GET')
  })

  it('model_urls 是「格式 → 地址」的字典，只列真的生成了的格式', async () => {
    responders['GET /openapi/v1/image-to-3d/'] = () =>
      jsonResponse({
        status: 'SUCCEEDED',
        model_urls: { glb: 'https://cdn/m.glb', fbx: 'https://cdn/m.fbx' }
      })
    const job = { poll: 'task-1', download: 'image-to-3d', cost: null }

    expect(await fetchModel3dFiles(provider(), job)).toEqual([
      { url: 'https://cdn/m.glb', name: 'model.glb' },
      { url: 'https://cdn/m.fbx', name: 'model.fbx' }
    ])
  })

  it('CANCELED 也算失败，不是「还没好」', async () => {
    responders['GET /openapi/v1/image-to-3d/'] = () =>
      jsonResponse({ status: 'CANCELED', task_error: '余额不足' })
    const job = { poll: 'task-1', download: 'image-to-3d', cost: null }

    const progress = await pollModel3d(provider(), job)
    expect(progress.failed).toBe(true)
    expect(progress.note).toBe('余额不足')
  })
})

/** 同 tripo 那组：多给的图必须真的到达厂商，否则四视图那一步是白花钱 */
describe('meshy 的多图', () => {
  beforeEach(() => useApi('meshy', 'meshy-7'))

  it('两张以上走 multi-image-to-3d，整组内联进 image_urls', async () => {
    const job = await submitModel3d(provider(), 'meshy-7', {
      images: ['front', 'left', 'back'].map(localImage)
    })

    const request = requestAt('/openapi/v1/multi-image-to-3d')
    const urls = request.json.image_urls as string[]
    expect(urls).toHaveLength(3)
    for (const url of urls) expect(url).toMatch(/^data:image\/png;base64,/)
    // 三张各自的字节不同，发的就该是三张不同的图，而不是第一张发三遍
    expect(new Set(urls).size).toBe(3)
    // 单数那一位是单图端点的入参
    expect(request.json).not.toHaveProperty('image_url')
    // 轮询端点按类型分叉，类型要跟着 job 存下来
    expect(job.download).toBe('multi-image-to-3d')
  })

  it('轮询打回 multi-image-to-3d 那一条，不是图生那一条', async () => {
    const job = await submitModel3d(provider(), 'meshy-7', {
      images: ['front', 'left'].map(localImage)
    })
    responders['GET /openapi/v1/multi-image-to-3d/'] = () =>
      jsonResponse({ status: 'SUCCEEDED', model_urls: { glb: 'https://cdn/m.glb' } })

    expect(await fetchModel3dFiles(provider(), job)).toEqual([
      { url: 'https://cdn/m.glb', name: 'model.glb' }
    ])
    // 用错端点拿到的是 404，看上去像 task id 过期了
    expect(requestAt(`/openapi/v1/multi-image-to-3d/${job.poll}`).method).toBe('GET')
  })

  it('精度与拓扑那几位在多图端点上照样发', async () => {
    await submitModel3d(provider(), 'meshy-7', {
      images: ['front', 'left'].map(localImage),
      quality: 'low',
      topology: 'quad'
    })

    const body = requestAt('/openapi/v1/multi-image-to-3d').json
    expect(body.should_remesh).toBe(true)
    expect(body.target_polycount).toBe(10_000)
    expect(body.topology).toBe('quad')
  })

  it('给第 5 张时明确报错，说清 1–4 张的限制并指路 Rodin', async () => {
    const images = ['a', 'b', 'c', 'd', 'e'].map(localImage)

    await expect(submitModel3d(provider(), 'meshy-7', { images })).rejects.toThrow(
      Model3dParamUnsupportedError
    )
    await expect(submitModel3d(provider(), 'meshy-7', { images })).rejects.toThrow(
      /1–4 张[\s\S]*Rodin/
    )
    // 这一家不用先换 token，所以一个请求都没发出去
    expect(sent).toHaveLength(0)
  })
})

/**
 * 真机上炸过的一次：提交成功、进度跑到 16%，然后一次 `fetch failed` 把整个
 * 任务判死。模型据此判断「网络抖动，没真正开始计费」，重试了三遍 ——
 * 而每一遍都是一次真实提交、一次真实扣费。
 */
describe('网络抖动不该让已付费的任务作废', () => {
  it('单次请求的网络异常会退避重连，不是一次就放弃', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
      calls += 1
      // 头两次连接层直接抛，第三次才通
      if (calls < 3) throw new TypeError('fetch failed')
      sent.push({
        url: String(input),
        method: init.method ?? 'POST',
        headers: {},
        json: typeof init.body === 'string' ? JSON.parse(init.body) : {}
      })
      return jsonResponse(SUBMIT_OK)
    })

    vi.useFakeTimers()
    const promise = submitModel3d(provider(), 'Gen-2', { prompt: '战斧' })
    await vi.advanceTimersByTimeAsync(5000)

    expect((await promise).poll).toBe('sub-key-for-status')
    expect(calls).toBe(3)
  })

  it('连不上到底时报错里说清连了几次，不是一句光秃秃的 fetch failed', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })

    vi.useFakeTimers()
    const settled = expect(submitModel3d(provider(), 'Gen-2', { prompt: '战斧' })).rejects.toThrow(
      /连了 \d+ 次都没连上/
    )
    await vi.advanceTimersByTimeAsync(10_000)
    await settled
  })

  /**
   * 这一条是整组里最值钱的：**提交之后**查不到状态，任务号必须活着出来，
   * 而且措辞要挡住「再试一次」—— 重新提交是再付一次全款。
   */
  it('提交成功后轮询断了，报错带着任务号并明说别重新提交', async () => {
    let polls = 0
    vi.stubGlobal('fetch', async (input: unknown) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/rodin')) return jsonResponse(SUBMIT_OK)
      polls += 1
      throw new TypeError('fetch failed')
    })

    vi.useFakeTimers()
    const settled = expect(generateModel3d({ prompt: '战斧' })).rejects.toThrow(
      /任务已经提交成功.*sub-key-for-status[\s\S]*不要重新提交/
    )
    await vi.advanceTimersByTimeAsync(600_000)
    await settled
    // 熬过了好几轮才认输，而不是第一次就放弃
    expect(polls).toBeGreaterThan(3)
  })

  /**
   * 用户按停止，取消的是**我们这边的等待**，不是厂商那边的任务 ——
   * 那个还在跑，钱也扣了。直接抛原始 AbortError 的话任务号就丢了，
   * 用户为一次点击付了全款却拿不到东西。
   */
  it('提交之后按停止，报错仍带任务号并说明还在跑', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', async (input: unknown) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/rodin')) return jsonResponse(SUBMIT_OK)
      controller.abort()
      throw new DOMException('The operation was aborted.', 'AbortError')
    })

    vi.useFakeTimers()
    const settled = expect(
      generateModel3d({ prompt: '战斧', signal: controller.signal })
    ).rejects.toThrow(/已停止等待.*sub-key-for-status[\s\S]*还在跑/)
    await vi.advanceTimersByTimeAsync(20_000)
    await settled
  })

  /** 厂商前缀可有可无：从厂商控制台复制回来的是裸任务号 */
  it('任务号带厂商前缀，裸任务号也认', async () => {
    expect(encodeModel3dJob({ poll: 'a', download: 'b', cost: null, providerId: 'tripo' })).toBe(
      'tripo:a~b'
    )
    expect(decodeModel3dJob('tripo:a~b')).toMatchObject({
      poll: 'a',
      download: 'b',
      providerId: 'tripo'
    })
    // 裸的：厂商回落到当前绑定，第二位缺失时用同一个值补上
    expect(decodeModel3dJob('task_x')).toMatchObject({ poll: 'task_x', download: 'task_x' })
    expect(decodeModel3dJob('task_x').providerId).toBeUndefined()
  })

  it('用户按停止时立刻退出，不当成抖动去重连', async () => {
    const controller = new AbortController()
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      controller.abort()
      throw new DOMException('The operation was aborted.', 'AbortError')
    })

    await expect(
      submitModel3d(provider(), 'Gen-2', { prompt: '战斧', signal: controller.signal })
    ).rejects.toThrow()
    expect(calls, '取消之后不该再连').toBe(1)
  })
})

describe('配置状态', () => {
  it('绑定齐全时报已配置', async () => {
    expect(await getModel3dStatus()).toEqual({ configured: true, model: 'Hyper3D:Gen-2' })
  })

  it('绑定在但 Provider 没写接口形状，等于没配 —— 发出去必然 404', async () => {
    settings.providers[0].model3dApi = undefined
    expect(await getModel3dStatus()).toEqual({ configured: false, model: null })
  })

  it('没有绑定时报未配置', async () => {
    settings.roles = {}
    expect(await getModel3dStatus()).toEqual({ configured: false, model: null })
  })
})

/**
 * Tripo 专属的那组开关。
 *
 * 这一组的共同点是**每一个都有前置条件**（分系列、分文生图生、互相排斥），
 * 而不满足的后果不是「不生效」那么轻 —— 是一次收费的 400，或者更贵的
 * 「参数被忽略、任务照跑、账照扣」，要到进引擎才发现拿到的东西不对。
 */
describe('tripo 的厂商特供开关', () => {
  const bodyOf = (): Record<string, unknown> => requestAt('/generation/text-to-model').json

  beforeEach(() => useApi('tripo', 'v3.1-20260211'))

  it('反向描述发成 negative_prompt', async () => {
    await submitModel3d(provider(), 'v3.1-20260211', {
      prompt: '战斧',
      vendor: { negativePrompt: '底座, 支架, 背景板' }
    })

    expect(bodyOf().negative_prompt).toBe('底座, 支架, 背景板')
  })

  it('反向描述超 255 字时本地拦掉，不白花一次 400', async () => {
    await expect(
      submitModel3d(provider(), 'v3.1-20260211', {
        prompt: '战斧',
        vendor: { negativePrompt: '底'.repeat(256) }
      })
    ).rejects.toThrow(/255/)
    expect(sent).toHaveLength(0)
  })

  /** extreme 和 detailed 只差一个词，模型很容易顺手写上去 */
  it('extreme 贴图精度只有 P 系列有，发给 H 系列明确报错', async () => {
    await expect(
      submitModel3d(provider(), 'v3.1-20260211', {
        prompt: '战斧',
        vendor: { textureQuality: 'extreme' }
      })
    ).rejects.toThrow(/extreme/)
    expect(sent).toHaveLength(0)
  })

  it('P 系列可以用 extreme', async () => {
    useApi('tripo', 'P1-20260311')
    await submitModel3d(provider(), 'P1-20260311', {
      prompt: '战斧',
      vendor: { textureQuality: 'extreme' }
    })

    expect(bodyOf().texture_quality).toBe('extreme')
  })

  it('几何精细档发给 P 系列时报错并指路 H 系列', async () => {
    useApi('tripo', 'P1-20260311')
    await expect(
      submitModel3d(provider(), 'P1-20260311', {
        prompt: '战斧',
        vendor: { geometryQuality: 'detailed' }
      })
    ).rejects.toThrow(/P 系列/)
    expect(sent).toHaveLength(0)
  })

  /**
   * 智能低模和 `quality` 那张表会打架：high 档给的 150,000 落在官方低模区间外面。
   * 两个都听等于一个都没听 —— 这个开关的意义就是「出低模」。
   */
  it('开了智能低模就把面数夹进官方区间', async () => {
    await submitModel3d(provider(), 'v3.1-20260211', {
      prompt: '战斧',
      quality: 'high',
      vendor: { smartLowPoly: true }
    })

    expect(bodyOf().smart_low_poly).toBe(true)
    expect(bodyOf().face_limit).toBe(20_000)
  })

  it('智能低模配四边面时区间更窄', async () => {
    await submitModel3d(provider(), 'v3.1-20260211', {
      prompt: '战斧',
      quality: 'high',
      topology: 'quad',
      format: 'fbx',
      vendor: { smartLowPoly: true }
    })

    expect(bodyOf().face_limit).toBe(10_000)
  })

  it('本来就在区间里的档位不动它', async () => {
    await submitModel3d(provider(), 'v3.1-20260211', {
      prompt: '战斧',
      quality: 'extra-low',
      vendor: { smartLowPoly: true }
    })

    expect(bodyOf().face_limit).toBe(3_000)
  })

  // 不给 quality 时厂商本来是自适应的，而自适应可能落在低模区间外面
  it('没给精度档时也按低模上限发面数', async () => {
    await submitModel3d(provider(), 'v3.1-20260211', {
      prompt: '战斧',
      vendor: { smartLowPoly: true }
    })

    expect(bodyOf().face_limit).toBe(20_000)
  })

  it('真实尺寸缩放发成 auto_size', async () => {
    await submitModel3d(provider(), 'v3.1-20260211', { prompt: '战斧', vendor: { autoSize: true } })

    expect(bodyOf().auto_size).toBe(true)
  })

  /** 文生没有「原图」可对齐，那几位发过去是无意义的 */
  it('对齐类开关在纯文字生成时明确报错', async () => {
    await expect(
      submitModel3d(provider(), 'v3.1-20260211', {
        prompt: '战斧',
        vendor: { alignOrientationToImage: true }
      })
    ).rejects.toThrow(/参考图/)
    expect(sent).toHaveLength(0)
  })

  it('有参考图时朝向对齐正常发出去', async () => {
    await submitModel3d(provider(), 'v3.1-20260211', {
      images: ['https://pic/front.png'],
      vendor: { alignOrientationToImage: true, textureAlignment: 'geometry', imageAutofix: true }
    })

    const body = requestAt('/generation/image-to-model').json
    expect(body.orientation).toBe('align_image')
    expect(body.texture_alignment).toBe('geometry')
    expect(body.enable_image_autofix).toBe(true)
  })

  it('分件输出与贴图互斥，同时给时报错', async () => {
    await expect(
      submitModel3d(provider(), 'v3.1-20260211', {
        prompt: '战斧',
        material: 'pbr',
        vendor: { generateParts: true }
      })
    ).rejects.toThrow(/互斥/)
    expect(sent).toHaveLength(0)
  })

  /** 它的默认值是带贴图的，不显式关掉的话这次请求自己和自己冲突 */
  it('单独开分件输出时显式关掉贴图和 PBR', async () => {
    await submitModel3d(provider(), 'v3.1-20260211', {
      prompt: '战斧',
      vendor: { generateParts: true }
    })

    expect(bodyOf()).toMatchObject({ generate_parts: true, texture: false, pbr: false })
  })

  it('一个都不给时请求体里不多出任何一位', async () => {
    await submitModel3d(provider(), 'v3.1-20260211', { prompt: '战斧' })

    const body = bodyOf()
    for (const key of ['negative_prompt', 'texture_quality', 'smart_low_poly', 'auto_size']) {
      expect(body).not.toHaveProperty(key)
    }
  })

  /**
   * 正常路径上走不到：工具那一层按绑定的厂商决定暴露哪些参数。留着是因为
   * 「静默忽略」在这条链路上最贵 —— 参数没生效、任务照跑、钱照扣。
   */
  it('发给别家时点名报错，且一次都不提交', async () => {
    useApi('rodin', 'Gen-2')
    await expect(
      submitModel3d(provider(), 'Gen-2', {
        prompt: '战斧',
        vendor: { negativePrompt: '底座', smartLowPoly: true }
      })
    ).rejects.toThrow(/negativePrompt \/ smartLowPoly/)
    expect(sent).toHaveLength(0)
  })
})
