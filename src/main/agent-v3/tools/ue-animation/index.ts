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

/**
 * 骨骼角色 → 骨名的显式映射。
 *
 * 插件先按 Manny 名、再按常见命名约定（Biped、Mixamo、Unity、Blender）自己认，
 * 认不出或认错时用这个点名。键不在这里用 enum 钉死：两个工具各带一份 23 项的
 * 枚举会把常驻组撑过预算（见 toolSearchCatalog.test.ts），而插件对未知角色
 * 本来就明确报错（`UAL_BoneRoles.h` 的 `Resolve`），不会静默忽略。
 */
const boneMap = z
  .record(z.string(), z.string().min(1))
  .optional()
  .describe(
    '角色→骨名，只在自动认错/认不出时传。角色：pelvis chest head，clavicle upperarm lowerarm hand thigh calf foot ball 加 _l/_r。例 {"chest":"Bip001-Spine2"}'
  )

const measure = defineTool({
  name: 'anim_measure',
  namespace: 'ue.animation',
  risk: 'safe',
  description:
    '测量人形身体动画。先量数字再看图。组件空间，厘米/度；视线只测头不测眼。' +
    '骨头按角色认：先 Manny 名，再按 Biped / Mixamo / Unity / Blender 命名约定；回执的 bone_roles 是认到的骨头，' +
    'bone_roles_by_naming_convention 是按约定猜的，量之前核一眼，认错了用 bone_map 点名。' +
    '缺角色或身体转身导致固定朝向指标不适用时返回 unmeasurable，不能当作通过。' +
    'describe=true 只读帧率、帧数、缺失轨道和角色表。默认量七项；frames 不传采全部帧。bones / angle_bones 收骨名或角色名。',
  input: z.object({
    path: asset,
    describe: z.boolean().default(false),
    metrics: z.array(metrics).min(1).optional(),
    frames: z.array(z.number().int().min(0)).min(1).max(10000).optional(),
    bones: z.array(z.string().min(1)).max(32).optional().describe('要回世界坐标序列的骨名或角色名'),
    angle_bones: z
      .array(z.string().min(1))
      .length(4)
      .optional()
      .describe('两条骨向量的起点、终点，共四个骨名或角色名'),
    bone_map: boneMap
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
    '给骨骼网格播放动画的指定时刻，返回一张姿势预览图。秒制时间；同骨架。一次一张，用 front/side/three_quarter 机位。' +
    '机位按锁骨和脚算身体正面（骨头认法同 anim_measure，可传 bone_map）；认不出时按网格 +Y 当正面并在回执里说明。' +
    '与 anim_measure 同帧对照，不凭单张图断言整段动画正确。',
  input: z.object({
    mesh: asset,
    animation: asset,
    time: z.number().min(0),
    camera: z.enum(['front', 'side', 'three_quarter']).default('three_quarter'),
    bone_map: boneMap
  }),
  execute: async (input, ctx) => {
    const result = await callUe<{ path: string; camera_basis?: string }>('anim.preview', input, {
      timeoutMs: 120_000,
      signal: ctx.signal
    })
    // 插件那边渲的是 1280×720 的 PNG（见 UAL_EditorCommands.cpp 的
    // CaptureAnimationPreview），原样 base64 塞进上下文是几 MB —— 视口截图和
    // Widget 预览都压过再进，这条也一样，理由见 `tools/contextImage.ts`
    const preview = await compressForContext(await readFile(result.path))
    // 认不出身体朝向时插件按网格 +Y 摆机位 —— 这张「front」未必是正面，得让模型知道
    const basis =
      result.camera_basis === 'mesh_plus_y_assumed'
        ? '\n这副骨架上认不出锁骨和脚，机位按网格 +Y 当正面摆的，front/side 未必是身体的正面/侧面；需要准确机位就传 bone_map。'
        : ''
    const head = `姿势预览：${input.animation}，${input.time} 秒，${input.camera}。${result.path}${basis}`
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
