import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { compressForContext, describeResize } from '../contextImage'
import { callUe } from '../defineUeTool'
import { defineTool, type UnrealAgentTool } from '../defineTool'

const asset = z.string().trim().min(1).describe('UE 资产路径，如 /Game/Anim/Talk_01')
const metrics = z.enum([
  'elbow_out_deg',
  'toe_out_deg',
  'knee_bend_deg',
  'gaze_pitch_deg',
  'vertical_range_cm',
  'torso_yaw_deg',
  'hand_step_cm'
])
type Result = Record<string, unknown>

const measure = defineTool({
  name: 'anim_measure',
  namespace: 'ue.animation',
  risk: 'safe',
  description:
    '测量 Manny / MetaHuman 身体动画。先量数字再看图。组件空间，厘米/度；视线只测头不测眼。缺骨或身体转身导致固定朝向指标不适用时返回 unmeasurable，不能当作通过。describe=true 只读帧率、帧数和缺失轨道。默认量七项；frames 不传采全部帧。',
  input: z.object({
    path: asset,
    describe: z.boolean().default(false),
    metrics: z.array(metrics).min(1).optional(),
    frames: z.array(z.number().int().min(0)).min(1).max(10000).optional(),
    bones: z.array(z.string().min(1)).max(32).optional(),
    angle_bones: z
      .array(z.string().min(1))
      .length(4)
      .optional()
      .describe('两条骨向量的起点、终点，共四个骨名')
  }),
  execute: async (input, ctx) => {
    const result = await callUe<Result>('anim.measure', input, {
      timeoutMs: 120_000,
      signal: ctx.signal
    })
    return { text: JSON.stringify(result), details: result }
  }
})

const preview = defineTool({
  name: 'anim_preview',
  namespace: 'ue.animation',
  risk: 'safe',
  concurrency: 'sequential',
  description:
    '给骨骼网格播放动画的指定时刻，返回一张姿势预览图。秒制时间；同骨架。一次一张，用 front/side/three_quarter 机位。与 anim_measure 同帧对照，不凭单张图断言整段动画正确。',
  input: z.object({
    mesh: asset,
    animation: asset,
    time: z.number().min(0),
    camera: z.enum(['front', 'side', 'three_quarter']).default('three_quarter')
  }),
  execute: async (input, ctx) => {
    const result = await callUe<{ path: string }>('anim.preview', input, {
      timeoutMs: 120_000,
      signal: ctx.signal
    })
    // 插件那边渲的是 1280×720 的 PNG（见 UAL_EditorCommands.cpp 的
    // CaptureAnimationPreview），原样 base64 塞进上下文是几 MB —— 视口截图和
    // Widget 预览都压过再进，这条也一样，理由见 `tools/contextImage.ts`
    const preview = await compressForContext(await readFile(result.path))
    const head = `姿势预览：${input.animation}，${input.time} 秒，${input.camera}。${result.path}`
    const resized = preview && describeResize(preview)
    return {
      text: preview
        ? resized
          ? `${head}\n${resized}`
          : head
        : `姿势预览已渲染到 ${result.path}，但那张图读不进上下文，你看不到它。` +
          '别对这一帧的姿势下判断 —— 改用 anim_measure 量数字。',
      ...(preview ? { images: [preview] } : {}),
      details: result
    }
  }
})

const writePose = defineTool({
  name: 'anim_write_pose',
  namespace: 'ue.animation',
  risk: 'mutating',
  concurrency: 'sequential',
  description:
    '把同骨架另一段非叠加动画的一个时刻写入目标动画的闭区间帧。全部骨轨道，缺轨道按参考姿势；区间外保持原关键帧，transition_frames 在区间前后插值。逐帧比较局部变换后保存；返回失败时先回读，不盲重试。完成后 anim_measure + anim_preview 展示效果。',
  input: z.object({
    path: asset,
    source: asset,
    source_time: z.number().min(0),
    start_frame: z.number().int().min(0),
    end_frame: z.number().int().min(0),
    transition_frames: z.number().int().min(0).default(0)
  }),
  execute: async (input, ctx) => {
    if (input.end_frame < input.start_frame) throw new Error('end_frame 必须不小于 start_frame')
    const result = await callUe<Result>('anim.write_pose', input, {
      timeoutMs: 120_000,
      signal: ctx.signal
    })
    return { text: JSON.stringify(result), details: result }
  }
})

const retarget = defineTool({
  name: 'anim_retarget',
  namespace: 'ue.animation',
  risk: 'mutating',
  concurrency: 'sequential',
  description:
    '批量重定向身体动画。引擎一次只处理一段；停止 = 当前这段完成后停止，不再发下一段。source_mesh/target_mesh 指定网格，animations 每项指定源资产和新的输出路径（不覆盖）。可选 retargeter 指定已有配置，复用且不重新对齐；否则自动创建配置。先读 ue-animation-retargeting 技能；输出后量数字并截图。',
  input: z.object({
    source_mesh: asset,
    target_mesh: asset,
    retargeter: asset.optional(),
    animations: z
      .array(z.object({ animation: asset, output_path: asset }))
      .min(1)
      .max(100)
  }),
  execute: async (input, ctx) => {
    if (new Set(input.animations.map((item) => item.output_path)).size !== input.animations.length)
      throw new Error('输出路径不能重复')
    const outputs: Result[] = []
    let retargeter = input.retargeter
    for (const item of input.animations) {
      if (ctx.signal?.aborted) break
      // Do not cancel the pending RPC: the engine finishes this item; no later item is sent.
      const result = await callUe<Result>(
        'anim.retarget',
        {
          source_mesh: input.source_mesh,
          target_mesh: input.target_mesh,
          ...item,
          ...(retargeter ? { retargeter } : {})
        },
        { timeoutMs: 30 * 60_000 }
      )
      outputs.push(result)
      if (typeof result.retargeter === 'string') retargeter = result.retargeter
      if (!ctx.signal?.aborted)
        ctx.report({
          text: `已导出 ${outputs.length}/${input.animations.length} 段：${item.output_path}`
        })
    }
    const result = { outputs, stopped: Boolean(ctx.signal?.aborted) }
    return { text: JSON.stringify(result), details: result }
  }
})

export function animationTools(): UnrealAgentTool<never>[] {
  return [measure, preview, writePose, retarget] as unknown as UnrealAgentTool<never>[]
}
