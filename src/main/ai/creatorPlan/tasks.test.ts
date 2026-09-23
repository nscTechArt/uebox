/** @vitest-environment node */
/**
 * uebox-tasks 客户端（协议 05-tasks）与视频 / 3D / 音乐三个分支。假 fetch，不连服务。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '../types'

const dirs = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => dirs.userData },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf-8')
  }
}))

const planState = vi.hoisted(() => ({
  manifest: null as null | { roles: Record<string, unknown> }
}))
vi.mock('./planState', () => ({
  readPlanState: async () => ({
    originals: {},
    etag: null,
    manifest: planState.manifest,
    unauthorized: false
  }),
  updatePlanState: async () => undefined
}))

const settings = vi.hoisted(() => ({
  version: 3,
  providers: [] as ProviderConfig[],
  roles: {} as Record<string, { providerId: string; modelId: string }>
}))
vi.mock('../store', () => ({ readSettings: async () => settings }))

const tasks = await import('./tasks')
const { generateVideo, resumeVideo, planVideoBody } = await import('../video')
const { generateModel3d, planModel3dBody } = await import('../model3d')
const { generateTaskMusic } = await import('../music')

const BASE = 'https://plan.example/v1'

function provider(id: string, kind: ProviderConfig['kind'], model: string): ProviderConfig {
  return {
    id,
    displayName: 'Box Plan',
    kind,
    protocol: 'openai-completions',
    baseUrl: BASE,
    apiKey: { kind: 'env', name: 'UEBOX_PLAN_TEST_KEY' },
    ...(kind === 'video' ? { videoApi: 'uebox-tasks' as const } : {}),
    ...(kind === 'model3d' ? { model3dApi: 'uebox-tasks' as const } : {}),
    ...(kind === 'music' ? { musicApi: 'uebox-tasks' as const } : {}),
    models: [{ id: model }]
  }
}

const video = provider('creator-plan-video', 'video', 'uebox-video')
const model3d = provider('creator-plan-model3d', 'model3d', 'uebox-3d')
const music = provider('creator-plan-music', 'music', 'uebox-music')

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body: Record<string, unknown> | null
}

function taskObject(id: string, status: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id,
    model: 'uebox-video',
    status,
    progress: 0,
    output: null,
    error: null,
    usage: null,
    metadata: {},
    ...extra
  }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function stubFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const call = {
      method: init.method ?? 'GET',
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      body:
        typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    }
    calls.push(call)
    return handler(call)
  })
  return calls
}

/** 睡眠立即返回、但记下间隔 —— 轮询节奏按协议走 */
const slept: number[] = []
const deps = (): { sleep: (ms: number, signal?: AbortSignal) => Promise<void> } => ({
  sleep: async (ms: number, signal?: AbortSignal) => {
    slept.push(ms)
    if (signal?.aborted) throw signal.reason
  }
})

beforeEach(() => {
  process.env.UEBOX_PLAN_TEST_KEY = 'ubx-sk-test'
  dirs.userData = mkdtempSync(join(tmpdir(), 'uebox-tasks-'))
  slept.length = 0
  planState.manifest = null
  settings.providers = [video, model3d, music]
  settings.roles = {
    video: { providerId: video.id, modelId: 'uebox-video' },
    model3d: { providerId: model3d.id, modelId: 'uebox-3d' },
    music: { providerId: music.id, modelId: 'uebox-music' }
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(dirs.userData, { recursive: true, force: true })
})

/**
 * 假计时器只接管 setTimeout：有待触发的计时器就往前拨一秒，没有就让真的文件读写跑一轮，
 * 直到结果出来。
 */
async function drive<T>(promise: Promise<T>): Promise<T> {
  let settled = false
  promise.then(
    () => (settled = true),
    () => (settled = true)
  )
  for (let i = 0; i < 50_000 && !settled; i += 1) {
    if (vi.getTimerCount() > 0) await vi.advanceTimersByTimeAsync(1_000)
    else await new Promise((resolve) => setImmediate(resolve))
  }
  return promise
}

const ledger = (): { entries: Array<{ hash: string; key: string; taskId?: string }> } => {
  try {
    return JSON.parse(readFileSync(join(dirs.userData, 'creator-plan-tasks.json'), 'utf-8'))
  } catch {
    return { entries: [] }
  }
}

describe('提交', () => {
  it('带 Idempotency-Key；5xx / 网络断了用同一个键重发，服务端只建一个任务', async () => {
    let attempt = 0
    const calls = stubFetch(() => {
      attempt += 1
      if (attempt === 1) throw new TypeError('fetch failed')
      if (attempt === 2) return json({ error: { code: 'upstream_unavailable', message: 'x' } }, 503)
      return json(taskObject('task_1', 'queued'), 201)
    })
    const task = await tasks.submitPlanTask(
      video,
      { model: 'uebox-video', input: { prompt: 'x' } },
      'key-1',
      undefined,
      deps()
    )
    expect(task.id).toBe('task_1')
    expect(calls).toHaveLength(3)
    expect(calls.every((call) => call.headers['Idempotency-Key'] === 'key-1')).toBe(true)
    expect(calls[2]).toMatchObject({ method: 'POST', url: `${BASE}/tasks` })
    expect(calls[2].body).toEqual({ model: 'uebox-video', input: { prompt: 'x' } })
  })

  it('400 不重发；402 换成套餐文案', async () => {
    const calls = stubFetch(() =>
      json({ error: { code: 'invalid_request', message: '时长不对' } }, 400)
    )
    await expect(
      tasks.submitPlanTask(video, { model: 'uebox-video', input: {} }, 'k', undefined, deps())
    ).rejects.toThrow('时长不对')
    expect(calls).toHaveLength(1)
    stubFetch(() => json({ error: { code: 'quota_exhausted', message: 'x' } }, 402))
    await expect(
      tasks.submitPlanTask(video, { model: 'uebox-video', input: {} }, 'k', undefined, deps())
    ).rejects.toThrow('额度用完了')
  })

  it('429 daily_limit_reached 不重发：说今天的额度用完、什么时候恢复；限流的 429 照常重发', async () => {
    const daily = stubFetch(
      () =>
        new Response(JSON.stringify({ error: { code: 'daily_limit_reached', message: 'x' } }), {
          status: 429,
          headers: { 'Retry-After': '30000', 'X-Uebox-Daily-Reset': '2026-09-24T00:00:00Z' }
        })
    )
    const error = await tasks
      .submitPlanTask(video, { model: 'uebox-video', input: {} }, 'k', undefined, deps())
      .catch((e: unknown) => e)
    expect(daily).toHaveLength(1)
    expect(slept).toEqual([])
    expect(error).toMatchObject({
      planError: 'daily_limit_reached',
      detail: { dailyResetAt: '2026-09-24T00:00:00Z' }
    })
    expect((error as Error).message).toMatch(/今天的额度用完了，.+ 恢复/)

    let attempt = 0
    const limited = stubFetch(() => {
      attempt += 1
      return attempt === 1
        ? json({ error: { code: 'rate_limited', message: 'slow down' } }, 429)
        : json(taskObject('task_2', 'queued'), 201)
    })
    await tasks.submitPlanTask(video, { model: 'uebox-video', input: {} }, 'k', undefined, deps())
    expect(limited).toHaveLength(2)
  })

  it('每日上限没收下这次提交：账上划掉，下一次（明天）是新的提交', async () => {
    stubFetch(() => json({ error: { code: 'daily_limit_reached', message: 'x' } }, 429))
    await expect(
      tasks.runPlanTask(video, 'video', { model: 'uebox-video', input: { prompt: 'd' } }, deps())
    ).rejects.toMatchObject({ planError: 'daily_limit_reached' })
    expect(ledger().entries).toEqual([])
  })
})

describe('等待', () => {
  it('按协议间隔轮询（视频 10 秒、3D 5 秒、音乐 3 秒），成功回任务', async () => {
    for (const [kind, interval] of [
      ['video', 10_000],
      ['model3d', 5_000],
      ['music', 3_000]
    ] as const) {
      slept.length = 0
      let polls = 0
      stubFetch(() => {
        polls += 1
        return json(taskObject('t', polls < 2 ? 'running' : 'succeeded', { progress: polls * 50 }))
      })
      const done = await tasks.waitPlanTask(
        video,
        kind,
        tasks.parsePlanTask(taskObject('t', 'queued'))!,
        deps()
      )
      expect(done.status).toBe('succeeded')
      expect(slept).toEqual([interval, interval])
    }
  })

  it('失败：错误里说额度已退回', async () => {
    stubFetch(() =>
      json(taskObject('t', 'failed', { error: { code: 'task_timeout', message: '超时了' } }))
    )
    await expect(
      tasks.waitPlanTask(video, 'video', tasks.parsePlanTask(taskObject('t', 'running'))!, deps())
    ).rejects.toThrow(/超时了[\s\S]*额度已经退回/)
  })

  it('用户按停止：POST /tasks/{id}/cancel，服务端置 cancelled，额度退回', async () => {
    const controller = new AbortController()
    const calls = stubFetch((call) =>
      call.url.endsWith('/cancel')
        ? json(taskObject('t', 'cancelled'))
        : json(taskObject('t', 'running'))
    )
    controller.abort()
    const error = await tasks
      .waitPlanTask(video, 'video', tasks.parsePlanTask(taskObject('t', 'running'))!, {
        ...deps(),
        signal: controller.signal
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(tasks.PlanTaskCancelledError)
    expect((error as InstanceType<typeof tasks.PlanTaskCancelledError>).refunded).toBe(true)
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: `${BASE}/tasks/t/cancel` })
  })

  it('取消后 usage 没归零（3D、音乐提交之后、视频开始生成之后）：说清额度不退', async () => {
    for (const [kind, usage, reason] of [
      ['model3d', { model3d_tasks: 1.5 }, '已提交的 3D 取消后不退额度'],
      ['music', { music_tasks: 1 }, '已提交的音乐取消后不退额度'],
      ['video', { video_seconds: 12.5 }, '只有还在排队时取消才退']
    ] as const) {
      const controller = new AbortController()
      stubFetch((call) =>
        call.url.endsWith('/cancel')
          ? json(taskObject('t', 'cancelled', { usage }))
          : json(taskObject('t', 'running'))
      )
      controller.abort()
      const error = (await tasks
        .waitPlanTask(model3d, kind, tasks.parsePlanTask(taskObject('t', 'running'))!, {
          ...deps(),
          signal: controller.signal
        })
        .catch((e: unknown) => e)) as InstanceType<typeof tasks.PlanTaskCancelledError>
      expect(error).toBeInstanceOf(tasks.PlanTaskCancelledError)
      expect(error.outcome).toBe('kept')
      expect(error.refunded).toBe(false)
      expect(error.settled).toBe(true)
      expect(error.message).toContain('额度不退')
      expect(error.message).toContain(reason)
    }
  })

  it('取消得看 usage：归零算退了；没送到服务端是另一回事', () => {
    const task = (usage: unknown): ReturnType<typeof tasks.parsePlanTask> =>
      tasks.parsePlanTask(taskObject('t', 'cancelled', { usage }))
    expect(tasks.cancelOutcomeOf(task({ music_tasks: 0 }))).toBe('refunded')
    expect(tasks.cancelOutcomeOf(task(null))).toBe('refunded')
    expect(tasks.cancelOutcomeOf(task({ video_seconds: 0.5 }))).toBe('kept')
    expect(tasks.cancelOutcomeOf(null)).toBe('unconfirmed')
    expect(tasks.cancelOutcomeOf(tasks.parsePlanTask(taskObject('t', 'running')))).toBe(
      'unconfirmed'
    )
  })

  it('查询抖几次不放弃；404 当场认输', async () => {
    let polls = 0
    stubFetch(() => {
      polls += 1
      if (polls <= 3) return json({ error: { code: 'upstream_unavailable' } }, 502)
      return json(taskObject('t', 'succeeded'))
    })
    const done = await tasks.waitPlanTask(
      video,
      'video',
      tasks.parsePlanTask(taskObject('t', 'running'))!,
      deps()
    )
    expect(done.status).toBe('succeeded')

    stubFetch(() => json({ error: { code: 'not_found', message: 'Task not found' } }, 404))
    await expect(
      tasks.waitPlanTask(video, 'video', tasks.parsePlanTask(taskObject('t', 'running'))!, deps())
    ).rejects.toThrow('404')
  })
})

describe('崩溃后续上（本机账本）', () => {
  const body = { model: 'uebox-music', input: { prompt: 'epic', seconds: 60, instrumental: true } }

  it('提交前记账；账上有任务号时同一个请求不再提交，直接接着查', async () => {
    // 第一次：提交成功、拿到任务号，然后「崩了」（查询一直失败，账留着）
    let submitted = 0
    stubFetch((call) => {
      if (call.method === 'POST') {
        submitted += 1
        return json(taskObject('task_9', 'queued'), 201)
      }
      throw new TypeError('fetch failed')
    })
    await expect(tasks.runPlanTask(music, 'music', body, deps())).rejects.toBeInstanceOf(
      tasks.PlanTaskInterruptedError
    )
    expect(ledger().entries).toMatchObject([{ taskId: 'task_9' }])

    // 重启后同一个请求：不提交，GET 原来那个任务
    const calls = stubFetch(() => json(taskObject('task_9', 'succeeded')))
    const task = await tasks.runPlanTask(music, 'music', body, deps())
    expect(task.id).toBe('task_9')
    expect(submitted).toBe(1)
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
    // 调用方落盘之后划账
    await tasks.settlePlanTask(body)
    expect(ledger().entries).toEqual([])
  })

  it('提交那一下崩了（账上只有键）：带同一个键重发', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed')
    })
    await expect(tasks.runPlanTask(music, 'music', body, deps())).rejects.toThrow('fetch failed')
    const [entry] = ledger().entries
    expect(entry.taskId).toBeUndefined()

    const calls = stubFetch((call) =>
      call.method === 'POST'
        ? json(taskObject('task_2', 'queued'), 201)
        : json(taskObject('task_2', 'succeeded'))
    )
    await tasks.runPlanTask(music, 'music', body, deps())
    expect(calls[0].headers['Idempotency-Key']).toBe(entry.key)
  })

  it('失败的任务从账上划掉，下一次是新的一次生成', async () => {
    stubFetch((call) =>
      call.method === 'POST'
        ? json(taskObject('task_3', 'queued'), 201)
        : json(taskObject('task_3', 'failed', { error: { message: 'no' } }))
    )
    await expect(tasks.runPlanTask(music, 'music', body, deps())).rejects.toBeInstanceOf(
      tasks.PlanTaskFailedError
    )
    expect(ledger().entries).toEqual([])
  })

  it('取消了、额度不退：任务也结束了，同样从账上划掉', async () => {
    const controller = new AbortController()
    stubFetch((call) => {
      if (call.url.endsWith('/cancel')) {
        return json(taskObject('task_4', 'cancelled', { usage: { music_tasks: 1 } }))
      }
      controller.abort()
      return json(taskObject('task_4', 'running'), call.method === 'POST' ? 201 : 200)
    })
    await expect(
      tasks.runPlanTask(music, 'music', body, { ...deps(), signal: controller.signal })
    ).rejects.toMatchObject({ outcome: 'kept' })
    expect(ledger().entries).toEqual([])
  })
})

describe('视频分支（videoApi: uebox-tasks）', () => {
  it('字段一一对应：audio → generate_audio，首尾帧带 role，参考视频 / 音频包成 { url }', () => {
    expect(
      planVideoBody('uebox-video', {
        prompt: ' 城门推近 ',
        images: [
          { url: 'data:image/png;base64,AA', role: 'first_frame' },
          { url: 'https://a.example/last.jpg', role: 'last_frame' }
        ],
        duration: 5,
        resolution: '1080p',
        ratio: '16:9',
        audio: true,
        seed: 7
      })
    ).toEqual({
      model: 'uebox-video',
      input: {
        prompt: '城门推近',
        images: [
          { url: 'data:image/png;base64,AA', role: 'first_frame' },
          { url: 'https://a.example/last.jpg', role: 'last_frame' }
        ],
        duration: 5,
        resolution: '1080p',
        ratio: '16:9',
        generate_audio: true,
        seed: 7
      }
    })
    expect(
      planVideoBody('uebox-video', {
        prompt: 'x',
        videos: ['https://a.example/ref.mp4'],
        audios: ['data:audio/wav;base64,AA']
      }).input
    ).toMatchObject({
      videos: [{ url: 'https://a.example/ref.mp4' }],
      audios: [{ url: 'data:audio/wav;base64,AA' }]
    })
    // asset:// 是方舟素材库的 ID，套餐不收
    expect(() => planVideoBody('uebox-video', { prompt: 'x', videos: ['asset://1'] })).toThrow(
      'https'
    )
  })

  it('generateVideo 走任务客户端，任务令牌 providerId:taskId 照旧，用量取 video_seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      stubFetch((call) =>
        call.method === 'POST'
          ? json(taskObject('task_v', 'queued'), 201)
          : json(
              taskObject('task_v', 'succeeded', {
                output: {
                  files: [
                    { role: 'cover', url: 'https://plan.example/files/t/task_v/cover.jpg' },
                    { role: 'video', url: 'https://plan.example/files/t/task_v/video.mp4' }
                  ]
                },
                usage: { video_seconds: 5 }
              })
            )
      )
      const result = await drive(generateVideo({ prompt: '城门' }))
      expect(result).toEqual({
        url: 'https://plan.example/files/t/task_v/video.mp4',
        job: { id: 'task_v', providerId: 'creator-plan-video' },
        usage: 5
      })
      // 成功落了结果就划账
      expect(ledger().entries).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('resumeVideo 按任务号接着查，不提交', async () => {
    const calls = stubFetch(() =>
      json(
        taskObject('task_v', 'succeeded', {
          output: { files: [{ role: 'video', url: 'https://plan.example/v.mp4' }] }
        })
      )
    )
    const result = await resumeVideo({ jobId: 'creator-plan-video:task_v' })
    expect(result.url).toBe('https://plan.example/v.mp4')
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([`GET ${BASE}/tasks/task_v`])
  })
})

describe('3D 分支（model3dApi: uebox-tasks）', () => {
  it('多图带 view；厂商开关进 options，只发清单列了的键', () => {
    const body = planModel3dBody(
      'uebox-3d',
      {
        images: ['data:image/png;base64,AA', 'https://a.example/left.png'],
        format: 'fbx',
        quality: 'medium',
        topology: 'quad',
        vendor: { negativePrompt: '底座', autoSize: true }
      },
      ['negative_prompt', 'auto_size']
    )
    expect(body).toEqual({
      model: 'uebox-3d',
      input: {
        images: [
          { url: 'data:image/png;base64,AA', view: 'front' },
          { url: 'https://a.example/left.png', view: 'left' }
        ],
        format: 'fbx',
        quality: 'medium',
        topology: 'quad',
        options: { negative_prompt: '底座', auto_size: true }
      }
    })
    // 清单没列的键、协议没有的开关：本地点名报错，不静默丢
    expect(() =>
      planModel3dBody('uebox-3d', { prompt: 'x', boundingBox: [1, 2, 3] }, ['negative_prompt'])
    ).toThrow('bounding_box')
    expect(() =>
      planModel3dBody('uebox-3d', { prompt: 'x', vendor: { geometryQuality: 'detailed' } }, null)
    ).toThrow('geometryQuality')
  })

  it('generateModel3d：网格在前、预览在后，任务令牌可续跑', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      planState.manifest = { roles: { model3d: { model: 'uebox-3d', options: [] } } }
      stubFetch((call) =>
        call.method === 'POST'
          ? json(taskObject('task_m', 'queued'), 201)
          : json(
              taskObject('task_m', 'succeeded', {
                output: {
                  files: [
                    { role: 'preview', url: 'https://plan.example/files/t/task_m/preview.png' },
                    { role: 'model', url: 'https://plan.example/files/t/task_m/model.glb' }
                  ]
                }
              })
            )
      )
      const result = await drive(generateModel3d({ prompt: '长剑' }))
      expect(result.files.map((file) => file.name)).toEqual(['model.glb', 'preview.png'])
      expect(result.job).toMatchObject({ poll: 'task_m', providerId: 'creator-plan-model3d' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('音乐分支（musicApi: uebox-tasks）', () => {
  it('时长夹到清单范围，纯音乐；多条音频逐条落盘，第二次同一请求复用本地文件', async () => {
    planState.manifest = {
      roles: { music: { model: 'uebox-music', seconds: { min: 10, max: 240 } } }
    }
    const project = mkdtempSync(join(tmpdir(), 'uebox-music-'))
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const calls = stubFetch((call) => {
        if (call.url.startsWith('https://plan.example/files/'))
          return new Response(new Uint8Array([1, 2, 3]))
        return call.method === 'POST'
          ? json(taskObject('task_s', 'queued'), 201)
          : json(
              taskObject('task_s', 'succeeded', {
                output: {
                  files: [
                    { role: 'audio', url: 'https://plan.example/files/t/task_s/audio-1.mp3' },
                    { role: 'audio', url: 'https://plan.example/files/t/task_s/audio-2.mp3' }
                  ]
                }
              })
            )
      })
      const result = await drive(generateTaskMusic(music, 'uebox-music', '史诗管弦', 600, project))
      vi.useRealTimers()
      expect(calls[0].body).toEqual({
        model: 'uebox-music',
        input: { prompt: '史诗管弦', seconds: 240, instrumental: true }
      })
      expect(result.tracks).toHaveLength(2)
      expect(result.reused).toBe(false)
      expect([...readFileSync(result.tracks[1].path)]).toEqual([1, 2, 3])

      const again = await generateTaskMusic(music, 'uebox-music', '史诗管弦', 600, project)
      expect(again.reused).toBe(true)
    } finally {
      vi.useRealTimers()
      rmSync(project, { recursive: true, force: true })
    }
  })
})
