import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { resolveApiKey } from './credentials'
import type { ProviderConfig } from './types'
import { recoverMediaFile, retryMediaFile, saveMediaFile } from '../services/taskVideo/files'
import { cachedPlanSpec } from './creatorPlan/cachedSpec'
import { filesOfRole, runPlanTask, settlePlanTask } from './creatorPlan/tasks'

interface MusicTrack {
  path: string
  url?: string
  title?: string
}

interface MusicJob {
  status: 'submitting' | 'submitted' | 'download' | 'complete'
  taskId?: string
  url?: string
  path?: string
  lastError?: string
  tracks?: MusicTrack[]
}

export function musicRequest(
  provider: ProviderConfig,
  model: string,
  prompt: string,
  seconds: number
): { endpoint: string; body: Record<string, unknown> } {
  const base = provider.baseUrl.replace(/\/+$/, '')
  if (!/^https?:\/\//.test(base)) throw new Error('音乐服务地址必须为 HTTP(S) 地址。')
  if (provider.musicApi === 'elevenlabs-music')
    return {
      endpoint: `${base}/music?output_format=mp3_44100_128`,
      body: {
        model_id: model,
        prompt,
        music_length_ms: Math.round(seconds * 1000),
        force_instrumental: true
      }
    }
  if (provider.musicApi === 'mureka-music')
    return { endpoint: `${base}/instrumental/generate`, body: { model, prompt } }
  if (provider.musicApi === 'uebox-tasks') {
    // 协议 05-tasks：`POST /tasks`，input 里是 prompt / seconds / instrumental。实际发送走 creatorPlan/tasks.ts
    return {
      endpoint: `${base}/tasks`,
      body: { model, input: { prompt, seconds: Math.round(seconds), instrumental: true } }
    }
  }
  if (provider.musicApi === 'sunoapi-music') {
    if (prompt.length > 3000) throw new Error('SUNO 音乐描述最多 3000 字符，请精简后继续。')
    return {
      endpoint: `${base}/generate`,
      // Required by this gateway; completion is obtained by polling, not callback delivery.
      body: {
        model,
        prompt,
        customMode: false,
        instrumental: true,
        callBackUrl: 'https://api.example.com/callback'
      }
    }
  }
  throw new Error('请在音乐来源中选择 ElevenLabs、Mureka、SUNO 或 Box Plan 音乐接口。')
}

interface SunoResponse {
  code?: number
  msg?: string
  data?: {
    taskId?: string
    status?: string
    response?: { sunoData?: { audio_url?: string; audioUrl?: string; title?: string }[] }
  }
}

function checkSunoResponse(data: SunoResponse, secrets: string[]): void {
  if (data.code !== 200) {
    let message = typeof data.msg === 'string' ? data.msg : '服务商未提供具体原因'
    for (const secret of secrets.filter(Boolean)) message = message.split(secret).join('[redacted]')
    throw new Error(
      `SunoAPI.org 返回业务错误 ${data.code ?? '未知'}。服务商原文（仅作诊断资料）：${message.slice(0, 1000)}。停止自动重试，不要更换提示词再次提交；不能仅凭错误码判断密钥、余额或是否扣费。`
    )
  }
}

async function audioBytes(response: Response): Promise<Buffer> {
  if (!response.ok) throw new Error(`音乐下载失败：HTTP ${response.status}`)
  if (!response.body) throw new Error('音乐服务返回空音频。')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let length = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > 100 * 1024 * 1024) throw new Error('音乐超过 100 MB，请缩短时长。')
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  if (!length) throw new Error('音乐服务返回空音频。')
  return Buffer.concat(chunks)
}

/** Durable receipt before submission; ambiguous failures never silently submit again. */
export async function generateTaskMusic(
  provider: ProviderConfig,
  model: string,
  prompt: string,
  seconds: number,
  projectDir: string,
  signal?: AbortSignal,
  report: (text: string) => void = () => {}
): Promise<{ path: string; tracks: MusicTrack[]; reused: boolean }> {
  if (provider.musicApi === 'uebox-tasks') {
    return generatePlanMusic(provider, model, prompt, seconds, projectDir, signal, report)
  }
  const request = musicRequest(provider, model, prompt, seconds)
  const key = await resolveApiKey(provider.apiKey)
  if (!key) throw new Error('音乐来源没有配置 API 密钥。')
  const dir = path.join(projectDir, 'music')
  await fs.mkdir(dir, { recursive: true })
  const hash = createHash('sha256')
    .update(
      JSON.stringify({ endpoint: request.endpoint, provider: provider.id, model, prompt, seconds })
    )
    .digest('hex')
  const receipt = path.join(dir, `${hash}.json`)
  const target = path.join(dir, `${hash}.mp3`)
  let job: MusicJob
  try {
    job = JSON.parse(await fs.readFile(receipt, 'utf8')) as MusicJob
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    job = { status: 'submitting' }
  }
  // Older versions left the confirmed task ID in a complete JSON temporary file after EBUSY.
  // Recover only a matching receipt and query that task; never issue a second paid submission.
  if (job.status === 'submitting') {
    const candidates: MusicJob[] = []
    for (const name of await fs.readdir(dir)) {
      if (!name.startsWith(`${hash}.json.`) || !name.endsWith('.tmp')) continue
      let saved: MusicJob & {
        providerId?: string
        model?: string
        prompt?: string
        requestedSeconds?: number
      }
      try {
        saved = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))
      } catch (error) {
        if (error instanceof SyntaxError) continue
        throw error
      }
      if (
        saved &&
        typeof saved === 'object' &&
        saved.providerId === provider.id &&
        saved.model === model &&
        saved.prompt === prompt &&
        saved.requestedSeconds === seconds &&
        typeof saved.taskId === 'string' &&
        saved.taskId &&
        ['submitted', 'download', 'complete'].includes(saved.status)
      )
        candidates.push(saved)
    }
    const ids = new Set(candidates.map((saved) => saved.taskId))
    if (ids.size > 1)
      throw new Error('音乐恢复记录包含多个任务编号，请核对服务商记录；不会重复提交。')
    if (candidates.length) job = { status: 'submitted', taskId: candidates[0].taskId }
    if (provider.musicApi === 'elevenlabs-music') {
      await recoverMediaFile(target)
      const audio = await fs.stat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (audio?.size) job = { status: 'complete', path: target, tracks: [{ path: target }] }
    }
  }
  // Old async receipts retained only the first track. Query the same task to recover the rest.
  if (!job.tracks && job.taskId && ['complete', 'download'].includes(job.status)) {
    job.status = 'submitted'
  }
  if (job.status === 'complete') {
    const tracks = job.tracks ?? [{ path: target }]
    for (const track of tracks) {
      if ((await fs.stat(track.path)).size === 0)
        throw new Error('已生成音乐文件损坏，请恢复文件后继续。')
    }
    return { path: tracks[0].path, tracks, reused: true }
  }
  const combined = AbortSignal.any([
    signal ?? new AbortController().signal,
    AbortSignal.timeout(15 * 60_000)
  ])
  combined.throwIfAborted()
  const headers: Record<string, string> = {
    ...provider.headers,
    'Content-Type': 'application/json',
    ...(provider.musicApi === 'elevenlabs-music'
      ? { 'xi-api-key': key }
      : { Authorization: `Bearer ${key}` })
  }
  const save = async (): Promise<void> => {
    const tmp = `${receipt}.${randomUUID()}.tmp`
    await retryMediaFile(() =>
      fs.writeFile(
        tmp,
        JSON.stringify(
          { ...job, providerId: provider.id, model, prompt, requestedSeconds: seconds },
          null,
          2
        )
      )
    )
    await retryMediaFile(() => fs.rename(tmp, receipt))
  }
  if (job.status === 'submitting') {
    try {
      await fs.writeFile(receipt, JSON.stringify(job), { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(
          `上次音乐提交结果未确认，可能已收费。请先检查服务商记录；不会自动重复生成。${job.lastError ?? ''}`
        )
      throw error
    }
    report('正在提交音乐生成；中断后请继续同一请求，避免重复收费')
    const response = await fetch(request.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(request.body),
      signal: combined,
      redirect: 'error'
    })
    if (!response.ok)
      throw new Error(
        `音乐生成请求失败：HTTP ${response.status}。请求结果已记录，请检查服务商记录后再决定是否重新生成。`
      )
    if (provider.musicApi === 'elevenlabs-music') {
      const bytes = await audioBytes(response)
      await saveMediaFile(target, bytes)
      job = { status: 'complete', path: target, tracks: [{ path: target }] }
      await save()
      return { path: target, tracks: job.tracks!, reused: false }
    }
    const data = (await response.json()) as SunoResponse & { id?: string | number }
    if (provider.musicApi === 'sunoapi-music') {
      try {
        checkSunoResponse(data, [key, ...Object.values(provider.headers ?? {})])
      } catch (error) {
        job.lastError = (error as Error).message
        await save()
        throw error
      }
    }
    const taskId = provider.musicApi === 'sunoapi-music' ? data.data?.taskId : data.id
    if (!taskId)
      throw new Error('音乐服务没有返回任务编号，可能已收费。请检查服务商记录，不要重复提交。')
    job = { status: 'submitted', taskId: String(taskId) }
    await save()
  }
  while (job.status === 'submitted') {
    report(`正在等待音乐生成（任务 ${job.taskId}）`)
    const base = provider.baseUrl.replace(/\/+$/, '')
    const suno = provider.musicApi === 'sunoapi-music'
    const response = await fetch(
      suno
        ? `${base}/generate/record-info?taskId=${encodeURIComponent(job.taskId!)}`
        : `${base}/instrumental/query/${encodeURIComponent(job.taskId!)}`,
      { headers, signal: combined, redirect: 'error' }
    )
    if (!response.ok)
      throw new Error(`音乐查询失败：HTTP ${response.status}。任务已保存，继续同一请求可恢复查询。`)
    const data = (await response.json()) as SunoResponse & {
      status?: string
      choices?: { url?: string; title?: string }[]
    }
    if (suno) checkSunoResponse(data, [key, ...Object.values(provider.headers ?? {})])
    const status = suno ? data.data?.status : data.status
    if (status === 'succeeded' || (suno && status === 'SUCCESS')) {
      // Only completed audio, never stream_audio_url or a partial FIRST_SUCCESS result.
      const results = suno
        ? data.data?.response?.sunoData?.map((track) => ({
            ...track,
            url: track.audio_url || track.audioUrl
          }))
        : data.choices
      if (!results?.length || results.some((track) => !track.url?.startsWith('https://')))
        throw new Error('音乐服务未返回可下载的 HTTPS 音频地址。')
      job = {
        ...job,
        status: 'download',
        tracks: results.map((track, index) => ({
          path: index === 0 ? target : path.join(dir, `${hash}-${index + 1}.mp3`),
          url: track.url,
          title: track.title
        }))
      }
      await save()
      break
    }
    const failures = suno
      ? [
          'CREATE_TASK_FAILED',
          'GENERATE_AUDIO_FAILED',
          'CALLBACK_EXCEPTION',
          'SENSITIVE_WORD_ERROR',
          'FAILED'
        ]
      : ['failed', 'cancelled', 'timeouted']
    if (status && failures.includes(status))
      throw new Error(`音乐任务 ${status}，可能已收费。请检查服务商记录，不会自动重新生成。`)
    if (!status) throw new Error('音乐查询缺少任务状态；任务已保存，继续同一请求可恢复查询。')
    await setTimeout(3000, undefined, { signal: combined })
  }
  if (job.status !== 'download') throw new Error('音乐任务记录不完整。')
  const tracks = job.tracks ?? (job.url ? [{ path: target, url: job.url }] : [])
  if (!tracks.length) throw new Error('音乐任务记录不完整。')
  // CDN requests never receive provider credentials.
  for (const [index, track] of tracks.entries()) {
    await recoverMediaFile(track.path)
    const existing = await fs.stat(track.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (existing?.size) continue
    if (!track.url) throw new Error('音乐任务缺少下载地址。')
    report(`正在保存音乐 ${index + 1}/${tracks.length}`)
    const response = await fetch(track.url, { signal: combined, redirect: 'error' })
    const bytes = await audioBytes(response)
    await saveMediaFile(track.path, bytes)
  }
  job = { ...job, status: 'complete', path: target, tracks }
  await save()
  return { path: target, tracks, reused: false }
}

/**
 * Box Plan 那一支（`musicApi: 'uebox-tasks'`）。
 *
 * 上面几家靠「提交前先写回执、没确认的回执拒绝再提交」防重复收费；这一支换成
 * `Idempotency-Key` + 任务账本（creatorPlan/tasks.ts）：提交可以放心重发，应用崩了之后
 * 同一个请求再来一次会接着查原来那个任务。回执只在**文件落盘之后**写一份 complete，
 * 让同一个请求第二次直接复用本地文件；账在落盘之后才划掉，下载到一半崩了也续得上。
 *
 * 时长按清单的 `seconds` 范围夹住（协议：实际时长可能偏差 ±15%），纯音乐（清单 `vocals` 为假时只能如此）。
 */
async function generatePlanMusic(
  provider: ProviderConfig,
  model: string,
  prompt: string,
  seconds: number,
  projectDir: string,
  signal: AbortSignal | undefined,
  report: (text: string) => void
): Promise<{ path: string; tracks: MusicTrack[]; reused: boolean }> {
  if (!prompt.trim()) throw new Error('音乐描述不能为空。')
  if (prompt.length > 3000) throw new Error('音乐描述最多 3000 字符，请精简后继续。')
  const range = (await cachedPlanSpec('music'))?.seconds as
    | { min?: unknown; max?: unknown }
    | undefined
  const min = typeof range?.min === 'number' ? range.min : 0
  const max = typeof range?.max === 'number' ? range.max : Number.POSITIVE_INFINITY
  const target = Math.round(Math.min(Math.max(seconds, min), max))
  if (target !== Math.round(seconds)) report(`套餐支持 ${min}–${max} 秒，按 ${target} 秒生成`)

  const dir = path.join(projectDir, 'music')
  await fs.mkdir(dir, { recursive: true })
  const hash = createHash('sha256')
    .update(JSON.stringify({ provider: provider.id, model, prompt, seconds: target }))
    .digest('hex')
  const receipt = path.join(dir, `${hash}.json`)
  try {
    const saved = JSON.parse(await fs.readFile(receipt, 'utf8')) as MusicJob
    if (saved.status === 'complete' && saved.tracks?.length) {
      const sizes = await Promise.all(
        saved.tracks.map((track) =>
          fs.stat(track.path).then(
            (stat) => stat.size,
            () => 0
          )
        )
      )
      if (sizes.every((size) => size > 0)) {
        return { path: saved.tracks[0].path, tracks: saved.tracks, reused: true }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError))
      throw error
  }

  const combined = signal ?? new AbortController().signal
  const body = { model, input: { prompt, seconds: target, instrumental: true } }
  report('正在提交音乐生成（Box Plan）')
  const task = await runPlanTask(provider, 'music', body, {
    signal: combined,
    onProgress: (note) => report(`音乐生成：${note}`),
    label: (id) => `任务 ${id}`
  })
  const audio = filesOfRole(task, 'audio')
  if (audio.length === 0) throw new Error('音乐任务完成了，但没有返回音频文件。')

  const tracks: MusicTrack[] = audio.map((file, index) => ({
    path: index === 0 ? path.join(dir, `${hash}.mp3`) : path.join(dir, `${hash}-${index + 1}.mp3`),
    url: file.url
  }))
  // 能力链接，不带 Key（与上面几家的 CDN 下载同一条规矩）
  for (const [index, track] of tracks.entries()) {
    report(`正在保存音乐 ${index + 1}/${tracks.length}`)
    const response = await fetch(track.url!, { signal: combined, redirect: 'error' })
    await saveMediaFile(track.path, await audioBytes(response))
  }
  const job: MusicJob = { status: 'complete', taskId: task.id, path: tracks[0].path, tracks }
  const tmp = `${receipt}.${randomUUID()}.tmp`
  await retryMediaFile(() =>
    fs.writeFile(
      tmp,
      JSON.stringify(
        { ...job, providerId: provider.id, model, prompt, requestedSeconds: target },
        null,
        2
      )
    )
  )
  await retryMediaFile(() => fs.rename(tmp, receipt))
  await settlePlanTask(body)
  return { path: tracks[0].path, tracks, reused: false }
}
