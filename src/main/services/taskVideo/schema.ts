import { z } from 'zod'

export const VideoScene = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  source: z.string().default('').describe('本地图片或视频绝对路径；文字卡片可省略。'),
  sourceNote: z.string().max(500).describe('素材出处；补拍、AI 补图或 AI 视频必须明确标记。'),
  kind: z.enum(['image', 'video', 'text', 'composition']),
  compositionAssets: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z0-9_-]+\.(png|jpe?g|webp|svg|woff2?|ttf|otf|mp4|webm)$/i),
        source: z.string()
      })
    )
    .max(100)
    .default([])
    .describe('composition 专用：HTML 使用 assets/name 引用的本地原始素材，工具复制原始字节。'),
  body: z.string().max(300).default('').describe('文字卡片的中心正文，可用换行组织步骤。'),
  title: z.string().max(60),
  caption: z.string().max(180),
  narration: z.string().max(600).default(''),
  // Rendered narration/read time can exceed the recommended 45 seconds. Saved boards must reload.
  duration: z.number().min(2).max(600),
  start: z.number().min(0).max(36000).default(0),
  zoom: z.number().min(1).max(1.15).default(1),
  focus: z
    .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
    .default({ x: 0.5, y: 0.5 })
})

export const VideoStoryboard = z
  .object({
    title: z.string().min(1).max(120),
    mode: z.enum(['tutorial', 'promo', 'creative']),
    ratio: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
    voice: z.enum(['auto', 'off']).default('auto'),
    musicPath: z.string().optional(),
    musicVolume: z.number().min(0).max(1).default(0.15),
    scenes: z.array(VideoScene).min(1).max(40)
  })
  .superRefine((value, ctx) => {
    for (const scene of value.scenes) {
      if (scene.kind !== 'text' && !scene.source.trim())
        ctx.addIssue({ code: 'custom', message: `镜头 ${scene.id} 缺少素材路径。` })
      if (scene.kind === 'text' && !(scene.title + scene.body + scene.caption).trim())
        ctx.addIssue({ code: 'custom', message: `文字镜头 ${scene.id} 不能为空。` })
    }
    if (new Set(value.scenes.map((scene) => scene.id)).size !== value.scenes.length)
      ctx.addIssue({ code: 'custom', message: '镜头 id 不能重复。' })
    if (value.scenes.reduce((sum, scene) => sum + scene.duration, 0) > 600)
      ctx.addIssue({ code: 'custom', message: '单条视频最长 10 分钟。' })
  })

export type Storyboard = z.infer<typeof VideoStoryboard>
export type Scene = z.infer<typeof VideoScene>

export function canvasSize(ratio: Storyboard['ratio']): [number, number] {
  return ratio === '9:16' ? [1440, 2560] : ratio === '1:1' ? [1440, 1440] : [2560, 1440]
}

export function assText(text: string): string {
  return text.replace(/\\/g, '＼').replace(/{/g, '｛').replace(/}/g, '｝').replace(/\r?\n/g, '\\N')
}

export function assTime(seconds: number): string {
  const cs = Math.round(seconds * 100)
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

/** Render titles and captions into separate safe bands; supplied text is never filter syntax. */
export function sceneSubtitles(scene: Scene, ratio: Storyboard['ratio'], duration: number): string {
  const [width, height] = canvasSize(ratio)
  const margin = Math.round(width * 0.06)
  const font = Math.round(((ratio === '16:9' ? 40 : 44) * 4) / 3)
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Caption,Microsoft YaHei,${font},&H00FFFFFF,&H00FFFFFF,&H00202020,&H80202020,0,0,0,0,100,100,0,0,3,2,0,2,${margin},${margin},${margin},1\nStyle: Title,Microsoft YaHei,${font + 16},&H00FFFFFF,&H00FFFFFF,&H00202020,&H80202020,-1,0,0,0,100,100,0,0,3,2,0,8,${margin},${margin},${margin},1\nStyle: Body,Microsoft YaHei,${font + 11},&H00FFFFFF,&H00FFFFFF,&H00202020,&H80202020,0,0,0,0,100,100,0,0,1,1,0,5,${margin},${margin},${margin},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,${assTime(duration)},Title,,0,0,0,,${assText(scene.title)}\nDialogue: 0,0:00:00.00,${assTime(duration)},Caption,,0,0,0,,${assText(scene.caption)}\nDialogue: 0,0:00:00.00,${assTime(duration)},Body,,0,0,0,,${assText(scene.body)}\n`
}
