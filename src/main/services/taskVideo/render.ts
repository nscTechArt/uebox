import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { retryMediaFile } from './files'
import { prepareVideoAudio } from './audio'
import { findFFmpeg } from '../ffmpegPath'
import { allowedMediaPath } from './project'
import { stageComposition, renderComposition } from './composition'
import { canvasSize, sceneSubtitles, type Scene, type Storyboard } from './schema'

export async function runVideoProcess(
  executable: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      signal,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const collect = (data: Buffer): void => {
      output = (output + data.toString()).slice(-16000)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`视频处理失败 (${code})：${output.slice(-1800)}`))
    )
  })
}

export async function videoPreflight(signal?: AbortSignal): Promise<string> {
  const ffmpeg = await findFFmpeg()
  if (!ffmpeg)
    throw new Error(
      '制作视频需要 FFmpeg。请先安装完整版本并加入 PATH，或配置 UNREAL_BOX_FFMPEG_PATH 后重启盒子，然后继续；尚未生成收费素材。'
    )
  const filters = await runVideoProcess(ffmpeg, ['-hide_banner', '-filters'], process.cwd(), signal)
  const encoders = await runVideoProcess(
    ffmpeg,
    ['-hide_banner', '-encoders'],
    process.cwd(),
    signal
  )
  if (!filters.includes('subtitles') || !encoders.includes('libx264'))
    throw new Error('当前 FFmpeg 缺少字幕或 H.264 编码能力，请安装完整版本后继续。')
  return ffmpeg
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).size > 0
  } catch {
    return false
  }
}

export function sceneFilter(scene: Scene, ratio: Storyboard['ratio'], duration: number): string {
  const [width, height] = canvasSize(ratio)
  // Reserve top/bottom bands rather than putting captions over tutorial controls.
  const innerHeight = Math.floor((height * 0.7) / 2) * 2
  const filters = [
    `scale=${width}:${innerHeight}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x17191c`,
    'setsar=1',
    'fps=30'
  ]
  if (scene.kind === 'image' && scene.zoom > 1) {
    filters.push(
      `zoompan=z='1+${scene.zoom - 1}*on/${Math.ceil(duration * 30)}':x='(iw-iw/zoom)*${scene.focus.x}':y='(ih-ih/zoom)*${scene.focus.y}':d=1:s=${width}x${height}:fps=30`
    )
  }
  filters.push(
    `fade=t=in:d=0.18`,
    `fade=t=out:st=${Math.max(0, duration - 0.18)}:d=0.18`,
    'subtitles=captions.ass'
  )
  return filters.join(',')
}

export interface RenderResult {
  videoPath: string
  storyboardPath: string
  duration: number
  voiceUsed: boolean
  previews: string[]
}

/** Each invocation owns a new render folder. Paid narration is reused by content + voice. */
export async function renderTaskVideo(
  projectDir: string,
  storyboard: Storyboard,
  signal?: AbortSignal,
  report: (text: string) => void = () => {}
): Promise<RenderResult> {
  const ffmpeg = await videoPreflight(signal)
  // Validate every input before any paid request. Never pass remote URLs/playlists to FFmpeg.
  const sources: (string | undefined)[] = []
  for (const scene of storyboard.scenes) {
    signal?.throwIfAborted()
    if (scene.kind === 'text') {
      sources.push(undefined)
      continue
    }
    if (scene.kind === 'composition') {
      sources.push(await stageComposition(projectDir, scene))
      continue
    }
    const source = await allowedMediaPath(scene.source)
    const supported = scene.kind === 'image' ? /\.(png|jpe?g|webp|bmp)$/i : /\.(mp4|mov|webm|mkv)$/i
    if (!supported.test(source)) throw new Error(`不支持的${scene.kind}素材：${source}`)
    sources.push(source)
  }
  const music = storyboard.musicPath ? await allowedMediaPath(storyboard.musicPath) : undefined
  if (music && !/\.(mp3|wav|ogg|m4a|flac)$/i.test(music)) throw new Error('不支持的音乐格式。')
  const prepared = await prepareVideoAudio(projectDir, storyboard, signal, report)
  const renderDir = path.join(projectDir, `render-${randomUUID()}`)
  await fs.mkdir(renderDir, { recursive: true })
  const storyboardPath = path.join(renderDir, 'storyboard.json')
  await fs.writeFile(storyboardPath, JSON.stringify(storyboard, null, 2))
  const actualScenes: Scene[] = []
  const previews: string[] = []
  let totalDuration = 0
  const voiceUsed = prepared.voiceUsed
  for (const [index, scene] of storyboard.scenes.entries()) {
    signal?.throwIfAborted()
    report(`正在制作第 ${index + 1}/${storyboard.scenes.length} 个镜头：${scene.title}`)
    const sceneDir = path.join(renderDir, scene.id)
    await fs.mkdir(sceneDir)
    let staged = ''
    const source = sources[index]
    if (source && scene.kind === 'composition') staged = source
    else if (source) {
      const sourceHash = createHash('sha256')
      for await (const chunk of createReadStream(source)) {
        signal?.throwIfAborted()
        sourceHash.update(chunk)
      }
      staged = path.join(
        projectDir,
        'assets',
        `${sourceHash.digest('hex')}${path.extname(source).toLowerCase()}`
      )
      if (!(await exists(staged))) await retryMediaFile(() => fs.copyFile(source, staged))
    }
    const duration = prepared.storyboard.scenes[index].duration
    const speechFile = prepared.audio[index]
    totalDuration += duration
    actualScenes.push({
      ...scene,
      source: staged,
      duration,
      ...(scene.kind === 'composition'
        ? {
            compositionAssets: scene.compositionAssets.map((asset) => ({
              ...asset,
              source: path.join(path.dirname(staged), 'assets', asset.name)
            }))
          }
        : {})
    })
    if (scene.kind === 'composition') {
      const picture = path.join(sceneDir, 'picture.mp4')
      const frames = await renderComposition({
        source: staged,
        output: picture,
        ffmpeg,
        ratio: storyboard.ratio,
        duration,
        signal,
        report,
        timeOffset: totalDuration - duration
      })
      previews.push(...frames.map((sample) => sample.path))
      await runVideoProcess(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          picture,
          ...(speechFile
            ? ['-f', 's16le', '-ar', '24000', '-ac', '1', '-i', speechFile]
            : ['-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono']),
          '-map',
          '0:v:0',
          '-map',
          '1:a:0',
          '-c:v',
          'copy',
          '-c:a',
          'aac',
          '-ar',
          '48000',
          '-ac',
          '2',
          '-af',
          'apad',
          '-t',
          String(duration),
          '-movflags',
          '+faststart',
          'scene.mp4'
        ],
        sceneDir,
        signal
      )
      continue
    }
    await fs.writeFile(
      path.join(sceneDir, 'captions.ass'),
      sceneSubtitles(scene, storyboard.ratio, duration)
    )
    const cachedScene = path.join(
      projectDir,
      'scenes',
      digest({ renderer: 2, scene: actualScenes.at(-1), ratio: storyboard.ratio, speechFile })
    )
    await fs.mkdir(cachedScene, { recursive: true })
    if (
      (await exists(path.join(cachedScene, 'scene.mp4'))) &&
      (await exists(path.join(cachedScene, 'preview.jpg')))
    ) {
      await fs.copyFile(path.join(cachedScene, 'scene.mp4'), path.join(sceneDir, 'scene.mp4'))
      await fs.copyFile(path.join(cachedScene, 'preview.jpg'), path.join(sceneDir, 'preview.jpg'))
      previews.push(path.join(sceneDir, 'preview.jpg'))
      continue
    }
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-protocol_whitelist',
      'file,pipe',
      ...(scene.kind === 'text'
        ? ['-f', 'lavfi', '-i', `color=c=0x17191c:s=${canvasSize(storyboard.ratio).join('x')}:r=30`]
        : [
            ...(scene.kind === 'image'
              ? ['-f', 'image2', '-loop', '1']
              : [
                  '-f',
                  /\.(mp4|mov)$/i.test(staged) ? 'mov' : 'matroska',
                  '-ss',
                  String(scene.start)
                ]),
            '-i',
            staged
          ]),
      ...(speechFile
        ? ['-f', 's16le', '-ar', '24000', '-ac', '1', '-i', speechFile]
        : ['-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono']),
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-vf',
      `${sceneFilter(scene, storyboard.ratio, duration)},tpad=stop_mode=clone:stop_duration=${duration}`,
      '-af',
      'apad',
      '-t',
      String(duration),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      'scene.mp4'
    ]
    await runVideoProcess(ffmpeg, args, sceneDir, signal)
    const preview = path.join(sceneDir, 'preview.jpg')
    await runVideoProcess(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        String(duration / 2),
        '-i',
        'scene.mp4',
        '-frames:v',
        '1',
        preview
      ],
      sceneDir,
      signal
    )
    await fs.copyFile(path.join(sceneDir, 'scene.mp4'), path.join(cachedScene, 'scene.mp4'))
    await fs.copyFile(preview, path.join(cachedScene, 'preview.jpg'))
    previews.push(preview)
  }
  await fs.writeFile(
    path.join(renderDir, 'concat.txt'),
    storyboard.scenes.map((scene) => `file '${scene.id}/scene.mp4'`).join('\n')
  )
  report('正在合成视频和混音')
  const videoPath = path.join(renderDir, 'video.mp4')
  const input = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-f',
    'concat',
    '-safe',
    '1',
    '-i',
    'concat.txt'
  ]
  if (music) {
    const stagedMusic = path.join(renderDir, `music${path.extname(music)}`)
    await fs.copyFile(music, stagedMusic)
    input.push(
      '-stream_loop',
      '-1',
      '-i',
      stagedMusic,
      '-filter_complex',
      `[1:a]volume=${storyboard.musicVolume},afade=t=in:d=0.5,afade=t=out:st=${Math.max(0, totalDuration - 1.5)}:d=1.5[m];` +
        (voiceUsed
          ? '[0:a]asplit=2[voice][side];[m][side]sidechaincompress=threshold=0.02:ratio=6:attack=20:release=300[bgm];[voice][bgm]'
          : '[0:a][m]') +
        'amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]',
      '-map',
      '0:v:0',
      '-map',
      '[a]',
      '-c:a',
      'aac'
    )
  } else input.push('-c:a', 'copy')
  input.push('-c:v', 'copy', '-t', String(totalDuration), '-movflags', '+faststart', videoPath)
  await runVideoProcess(ffmpeg, input, renderDir, signal)
  if (!(await exists(videoPath))) throw new Error('成片没有成功写入磁盘。')
  await fs.writeFile(
    storyboardPath,
    JSON.stringify(
      {
        ...storyboard,
        musicPath: music ? path.join(renderDir, `music${path.extname(music)}`) : undefined,
        scenes: actualScenes
      },
      null,
      2
    )
  )
  const result = { videoPath, storyboardPath, duration: totalDuration, voiceUsed, previews }
  await fs.writeFile(path.join(renderDir, 'result.json'), JSON.stringify(result, null, 2))
  return result
}
