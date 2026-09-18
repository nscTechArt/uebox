/** Manual offline acceptance: real FFmpeg, synthetic audio, no model credentials or API calls.
 * Run: pnpm exec node scripts/smoke-task-video.mjs [output directory]
 */
import { build } from 'esbuild'
import { mkdir, mkdtemp, writeFile, readdir, readFile, rename } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const out = process.argv[2]
  ? path.resolve(process.argv[2])
  : await mkdtemp(path.join(tmpdir(), 'task-video-smoke-'))
await mkdir(out, { recursive: true })
const ffmpeg = process.env.UNREAL_BOX_FFMPEG_PATH || 'ffmpeg'
const entry = path.resolve('src/main/services/taskVideo/render.ts')
const bundle = path.join(out, 'render.cjs')
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  plugins: [
    {
      name: 'offline-fixtures',
      setup(builder) {
        builder.onResolve({ filter: /(?:ffmpegPath|ai\/store|ai\/speech)$/ }, (args) => ({
          path: args.path,
          namespace: 'fixture'
        }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          contents: args.path.endsWith('ffmpegPath')
            ? `export async function findFFmpeg(){return ${JSON.stringify(ffmpeg)}}`
            : args.path.endsWith('store')
              ? `export async function readSettings(){return globalThis.taskVideoSmokeSettings || {providers:[],roles:{}}}`
              : `export async function requestSpeech(provider,model,text,signal,onAudio){
                  if(!globalThis.taskVideoSmokeSettings) throw Error('Unexpected paid speech call');
                  globalThis.taskVideoSmokeCalls=(globalThis.taskVideoSmokeCalls||0)+1;
                  const pcm=Buffer.alloc(5*48000);
                  for(let i=0;i<pcm.length/2;i++) pcm.writeInt16LE(Math.round(Math.sin(i*440*2*Math.PI/24000)*1000),i*2);
                  onAudio({base64:pcm.toString('base64'),format:'pcm_s16le',sampleRate:24000});
                }`
        }))
      }
    }
  ]
})
const { renderTaskVideo, runVideoProcess } = createRequire(import.meta.url)(bundle)
const { VideoStoryboard } = await (async () => {
  const schema = path.join(out, 'schema.cjs')
  await build({
    entryPoints: [path.resolve('src/main/services/taskVideo/schema.ts')],
    outfile: schema,
    bundle: true,
    platform: 'node',
    format: 'cjs'
  })
  return createRequire(import.meta.url)(schema)
})()
await mkdir(path.join(out, 'assets'), { recursive: true })
const musicPath = path.join(out, 'tone.wav')
await runVideoProcess(
  ffmpeg,
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:duration=8',
    musicPath
  ],
  out
)
const source = path.resolve('resources/icon.png')
const board = VideoStoryboard.parse({
  title: '任务成片 · 离线验收',
  mode: 'tutorial',
  voice: 'auto',
  musicPath,
  scenes: [
    {
      id: 'intro',
      sourceNote: 'Text-only acceptance fixture',
      kind: 'text',
      body: '任务过程 → AI 文案\n素材、字幕、声音 → 本地成片',
      title: '虚幻盒子 · 任务成片',
      caption: '用任务素材，讲清楚制作过程。',
      narration: '没有配置语音时，不应该调用任何配音服务。',
      duration: 3,
      zoom: 1.03
    },
    {
      id: 'result',
      source,
      sourceNote: 'Repository app icon; acceptance fixture',
      kind: 'image',
      title: '字幕始终保留',
      caption: '修改文案，复用已有素材和声音。',
      duration: 3
    }
  ]
})
const first = await renderTaskVideo(out, board, undefined, console.log)
const second = await renderTaskVideo(
  out,
  { ...board, ratio: '9:16', musicVolume: 0.05 },
  undefined,
  console.log
)
const cacheBefore = (await readdir(path.join(out, 'scenes'))).sort()
const third = await renderTaskVideo(out, { ...board, musicVolume: 0.08 }, undefined, console.log)
assert.deepEqual(
  (await readdir(path.join(out, 'scenes'))).sort(),
  cacheBefore,
  'Music-only edit must reuse all scene encodes'
)
const imported = await renderTaskVideo(
  out,
  VideoStoryboard.parse({
    title: '已有视频剪辑',
    mode: 'creative',
    voice: 'off',
    scenes: [
      {
        id: 'clip',
        source: first.videoPath,
        sourceNote: 'Previous acceptance render',
        kind: 'video',
        title: '已有视频也可剪入',
        caption: '保留真实画面，重新安排讲解。',
        duration: 3,
        start: 0.5
      }
    ]
  }),
  undefined,
  console.log
)
globalThis.taskVideoSmokeSettings = {
  providers: [
    {
      id: 'fixture',
      kind: 'tts',
      baseUrl: 'https://fixture.invalid',
      models: [{ id: 'fixture', ttsVoice: 'tone' }]
    }
  ],
  roles: { tts: { providerId: 'fixture', modelId: 'fixture' } }
}
const voicedBoard = VideoStoryboard.parse({
  title: '配音时序测试',
  mode: 'tutorial',
  musicPath,
  scenes: [
    {
      id: 'voice',
      kind: 'text',
      sourceNote: 'Synthetic local audio test; no human voice',
      title: '配音缓存验收',
      body: '用本地测试音验证时长和缓存\n不调用任何付费模型',
      caption: '测试音频共五秒。',
      narration: '测试音频',
      duration: 2
    }
  ]
})
const voiced = await renderTaskVideo(out, voicedBoard, undefined, console.log)
assert.equal(voiced.voiceUsed, true)
assert.ok(voiced.duration >= 5.35)
const speechCalls = globalThis.taskVideoSmokeCalls || 0
assert.ok(speechCalls <= 1, 'At most one synthetic speech request is needed')
await renderTaskVideo(
  out,
  { ...voicedBoard, scenes: [{ ...voicedBoard.scenes[0], title: '改标题，复用配音' }] },
  undefined,
  console.log
)
assert.equal(
  globalThis.taskVideoSmokeCalls || 0,
  speechCalls,
  'Changing title must not regenerate speech'
)
const audioDir = path.join(out, 'audio')
const pcmName = (await readdir(audioDir)).find((name) => name.endsWith('.pcm'))
const pcmPath = path.join(audioDir, pcmName)
await rename(pcmPath, `${pcmPath}.legacy.tmp`)
try {
  await assert.rejects(renderTaskVideo(out, voicedBoard), /第 1 段配音存在旧版临时文件/)
  assert.equal(globalThis.taskVideoSmokeCalls || 0, speechCalls)
} finally {
  await rename(`${pcmPath}.legacy.tmp`, pcmPath)
}
const savedBoard = JSON.parse(await readFile(first.storyboardPath, 'utf8'))
const savedImage = savedBoard.scenes.find((scene) => scene.kind === 'image')
assert.deepEqual(
  await readFile(savedImage.source),
  await readFile(source),
  'Rendering must preserve original source bytes'
)
const probe = process.env.TASK_VIDEO_FFPROBE || 'ffprobe'
for (const result of [first, second, third, imported, voiced]) {
  const info = spawnSync(
    probe,
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_name,width,height:format=duration',
      '-of',
      'json',
      result.videoPath
    ],
    { windowsHide: true, encoding: 'utf8' }
  )
  if (info.status !== 0) throw new Error(info.stderr || 'ffprobe unavailable')
  const metadata = JSON.parse(info.stdout)
  const video = metadata.streams.find((stream) => stream.codec_name === 'h264')
  assert.deepEqual([video.width, video.height], result === second ? [1440, 2560] : [2560, 1440])
  assert.ok(Math.abs(Number(metadata.format.duration) - result.duration) < 0.15)
  console.log(info.stdout)
}
await writeFile(
  path.join(out, 'acceptance.json'),
  JSON.stringify({ landscape: first, portrait: second, remix: third, imported, voiced }, null, 2)
)
console.log(`Acceptance artifacts: ${out}`)
