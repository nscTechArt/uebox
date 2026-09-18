import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { setTimeout } from 'node:timers/promises'
import { allowedMediaPath } from './project'
import { retryMediaFile } from './files'
import { canvasSize, type Scene, type Storyboard } from './schema'

/** Explicit dependencies make rendered compositions portable and content-addressed. */
export async function stageComposition(projectDir: string, scene: Scene): Promise<string> {
  const source = await allowedMediaPath(scene.source)
  if (!/\.html?$/i.test(source)) throw new Error('composition 必须使用本地 HTML 文件。')
  const html = await fs.readFile(source)
  if (html.length > 4 * 1024 * 1024)
    throw new Error('镜头 HTML 超过 4 MB，请将图片移到 compositionAssets。')
  const names = new Set<string>()
  const assets: { name: string; bytes: Buffer }[] = []
  let size = 0
  for (const asset of scene.compositionAssets) {
    if (names.has(asset.name.toLowerCase())) throw new Error(`镜头素材名重复：${asset.name}`)
    names.add(asset.name.toLowerCase())
    const file = await allowedMediaPath(asset.source)
    size += (await fs.stat(file)).size
    if (size > 300 * 1024 * 1024) throw new Error('单镜头素材超过 300 MB，请剪短视频素材。')
    assets.push({ name: asset.name, bytes: await fs.readFile(file) })
  }
  const hash = createHash('sha256').update(html)
  for (const asset of assets) hash.update(asset.name).update(asset.bytes)
  const dir = path.join(projectDir, 'compositions', hash.digest('hex'))
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true })
  await retryMediaFile(() => fs.writeFile(path.join(dir, 'index.html'), html))
  for (const asset of assets)
    await retryMediaFile(() => fs.writeFile(path.join(dir, 'assets', asset.name), asset.bytes))
  return path.join(dir, 'index.html')
}

/** File requests may only read the immutable scene copy and the two shipped runtimes. */
export async function compositionFile(url: string, root: string, runtime: string): Promise<string> {
  const requested = fileURLToPath(url)
  const basename = path.basename(requested)
  const relative = path.relative(root, requested)
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('镜头引用了工程之外的文件。')
  const file =
    ['uebox-gsap.js', 'uebox-runtime.js'].includes(basename) && path.dirname(requested) === root
      ? path.join(runtime, basename === 'uebox-gsap.js' ? 'gsap.js' : 'hyperframes.js')
      : requested
  const real = await fs.realpath(file)
  const base = file === requested ? await fs.realpath(root) : await fs.realpath(runtime)
  const resolved = path.relative(base, real)
  if (resolved.startsWith('..') || path.isAbsolute(resolved))
    throw new Error('镜头素材不能通过链接读取工程外文件。')
  return real
}

export async function renderComposition(options: {
  source: string
  output: string
  ffmpeg: string
  ratio: Storyboard['ratio']
  duration: number
  signal?: AbortSignal
  report?: (text: string) => void
  previewOnly?: boolean
  sampleTimes?: number[]
}): Promise<string[]> {
  const { BrowserWindow, session, app } = await import('electron')
  const root = path.dirname(options.source)
  const runtime = app.isPackaged
    ? path.join(process.resourcesPath, 'task-video-runtime')
    : path.join(app.getAppPath(), 'src', 'renderer', 'public', 'task-video-runtime')
  const [width, height] = canvasSize(options.ratio)
  const isolated = session.fromPartition(`task-video-${randomUUID()}`, { cache: false })
  const failures = new Set<string>()
  isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.webRequest.onBeforeRequest((details, callback) => {
    const allowed = /^(file:|data:|blob:)/.test(details.url)
    if (!allowed) failures.add(`不允许联网素材：${details.url.slice(0, 180)}`)
    callback({ cancel: !allowed })
  })
  await isolated.protocol.handle('file', async (request) => {
    try {
      const file = await compositionFile(request.url, root, runtime)
      const types: Record<string, string> = {
        '.js': 'text/javascript',
        '.html': 'text/html',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.webp': 'image/webp',
        '.woff2': 'font/woff2',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm'
      }
      const bytes = await fs.readFile(file)
      const headers: Record<string, string> = {
        'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
        'Accept-Ranges': 'bytes'
      }
      const range = request.headers.get('range')?.match(/^bytes=(\d+)-(\d*)$/)
      if (range) {
        const start = Number(range[1]),
          end = Math.min(Number(range[2] || bytes.length - 1), bytes.length - 1)
        if (start > end)
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${bytes.length}` }
          })
        headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`
        headers['Content-Length'] = String(end - start + 1)
        return new Response(new Uint8Array(bytes.subarray(start, end + 1)), {
          status: 206,
          headers
        })
      }
      headers['Content-Length'] = String(bytes.length)
      return new Response(new Uint8Array(bytes), { headers })
    } catch (error) {
      failures.add(String(error))
      return new Response('Missing or denied asset', { status: 403 })
    }
  })
  const window = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show: false,
    webPreferences: {
      session: isolated,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      zoomFactor: 1,
      offscreen: true
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('console-message', (_event, level, message) => {
    if (level === 3) failures.add(message.slice(0, 250))
  })
  let encoder: ReturnType<typeof spawn> | undefined
  let encoderDone: Promise<void> | undefined
  const aborted = (): void => {
    encoder?.kill()
    if (!window.isDestroyed()) window.destroy()
  }
  options.signal?.addEventListener('abort', aborted, { once: true })
  const deadline = globalThis.setTimeout(aborted, 30 * 60_000)
  try {
    options.signal?.throwIfAborted()
    options.report?.('载入镜头')
    await window.loadURL(pathToFileURL(options.source).href)
    options.report?.('等待时间轴')
    window.webContents.setZoomFactor(1)
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      options.signal?.throwIfAborted()
      ready = await window.webContents.executeJavaScript(
        'Boolean(window.__renderReady && window.__player)'
      )
      if (ready) break
      await setTimeout(100)
    }
    if (!ready)
      throw new Error(
        '镜头时间轴未就绪：请加载 uebox-gsap.js、uebox-runtime.js 并注册暂停的 __timelines 时间轴。'
      )
    options.report?.('检查字体和素材')
    const metadata = await window.webContents.executeJavaScript(`(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images).map(i => i.decode()));
      const root = document.querySelector('[data-composition-id]');
      return {width:Number(root?.dataset.width), height:Number(root?.dataset.height), duration:Number(root?.dataset.duration)};
    })()`)
    if (metadata.width !== width || metadata.height !== height)
      throw new Error(`镜头画布应为 ${width}×${height}。`)
    if (
      !Number.isFinite(metadata.duration) ||
      Math.abs(metadata.duration - options.duration) > 1 / 30
    )
      throw new Error(
        `镜头 HTML 时长 ${metadata.duration} 秒与分镜实际时长 ${options.duration} 秒不一致，请按配音时长重新编排。`
      )
    if (failures.size) throw new Error([...failures].join('\n'))
    const count = Math.ceil(options.duration * 30)
    const samples = new Set([
      Math.min(count - 1, 6),
      Math.floor(count * 0.35),
      Math.floor(count * 0.7),
      Math.max(0, count - 7)
    ])
    for (const time of options.sampleTimes ?? []) {
      if (time >= 0 && time < options.duration) samples.add(Math.floor(time * 30))
    }
    const previews: string[] = []
    if (!options.previewOnly) {
      encoder = spawn(
        options.ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'rawvideo',
          '-pixel_format',
          'bgra',
          '-video_size',
          `${width}x${height}`,
          '-framerate',
          '30',
          '-i',
          'pipe:0',
          '-an',
          '-c:v',
          'libx264',
          '-preset',
          'medium',
          '-crf',
          '16',
          '-pix_fmt',
          'yuv420p',
          '-movflags',
          '+faststart',
          options.output
        ],
        { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] }
      )
      let stderr = ''
      encoder.stderr?.on('data', (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-2000)
      })
      encoderDone = new Promise((resolve, reject) => {
        encoder!.once('error', reject)
        encoder!.once('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`镜头编码失败：${stderr}`))
        )
      })
      void encoderDone.catch(() => {})
    }
    for (let frame = 0; frame < count; frame++) {
      options.signal?.throwIfAborted()
      if (options.previewOnly && !samples.has(frame)) continue
      await window.webContents.executeJavaScript(`(async () => {
        window.__player.enableRenderMode?.();
        window.__player.renderSeek(${frame / 30});
        await window.__hfWaitForSeekCompletion?.();
        const videos = Array.from(document.querySelectorAll('video')).filter(v => getComputedStyle(v).visibility !== 'hidden');
        await Promise.all(videos.map(async v => {
          for (let i = 0; i < 200; i++) {
            if (v.error) throw new Error('视频素材解码失败：' + v.error.message);
            if (v.readyState >= 2 && !v.seeking) return;
            await new Promise(r => setTimeout(r, 25));
          }
          throw new Error('视频素材未完成帧定位，请检查格式与 data-media-start。');
        }));
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      })()`)
      if (failures.size) throw new Error([...failures].join('\n'))
      const capture = await window.webContents.capturePage({ x: 0, y: 0, width, height })
      const size = capture.getSize()
      const raster =
        size.width === width && size.height === height ? capture : capture.resize({ width, height })
      if (samples.has(frame)) {
        const preview = path.join(path.dirname(options.output), `frame-${frame}.png`)
        await fs.writeFile(preview, raster.toPNG())
        previews.push(preview)
      }
      if (encoder)
        await new Promise<void>((resolve, reject) =>
          encoder!.stdin!.write(raster.toBitmap(), (error) => (error ? reject(error) : resolve()))
        )
      if (frame % 90 === 0) options.report?.(`精细渲染 ${Math.round((frame / count) * 100)}%`)
    }
    encoder?.stdin?.end()
    await encoderDone
    return previews
  } finally {
    globalThis.clearTimeout(deadline)
    options.signal?.removeEventListener('abort', aborted)
    aborted()
    await encoderDone?.catch(() => {})
    isolated.protocol.unhandle('file')
    isolated.webRequest.onBeforeRequest(null)
  }
}
