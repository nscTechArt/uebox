/**
 * `sequence_camera_keys` —— 把一串相机关键帧写进 Level Sequence。
 *
 * ## 为什么是它，而不是一堆「某某运镜」工具
 *
 * 前身是 `sequence_orbit`：参数是「转几圈、俯角多少、半径倍数」，只能生成圆周。
 * 它替模型把**创作决定**做了 —— 用户要个 8 字、要手持晃、要先升后俯，工具
 * 一个都表达不了，模型只能拿环绕去凑，或者把关键帧数值报给用户让他自己打。
 *
 * 分工改成这样：
 *
 *   - **模型**决定镜头怎么走：算轨迹、定节奏、选曲线。这是它该干的活
 *   - **工具**负责引擎那半边：怎么建相机、怎么打进通道、怎么绑切轨、什么会黑屏
 *
 * 所以这里没有任何「什么镜头好看」的参数。给一串帧和位置/朝向，写进去。
 * 环绕只是模型自己算 24 个点的一种用法，和 8 字、跟随、手持没有区别。
 *
 * ## 权限
 *
 * 它能覆盖已有的关键帧曲线 —— 这是有意的：不许覆盖就等于不许改用户的东西，
 * 那又变成工具替用户做决定。危险与否由用户在审批环节判断，工具的责任是
 * **把要覆盖的东西说清楚**（`replaced_keys` 会报出清掉了多少个键）。
 */

import { z } from 'zod'

import { callUe } from '../defineUeTool'
import { defineTool, type UnrealAgentTool } from '../defineTool'
import { withPartialHeadline } from '../partialResult'

const NAMESPACE = 'ue.sequencer'

const Vec3 = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number()
})

const Rot3 = z.object({
  roll: z.number().describe('绕视轴翻滚，画面跟着转'),
  pitch: z.number().describe('俯仰。正数抬头'),
  yaw: z.number().describe('偏航。连续累加，不要自己归一化到 -180..180，否则接缝处会反甩')
})

const KeySchema = z
  .object({
    frame: z.number().int().min(0).describe('第几帧。整数，从 0 起'),
    location: Vec3.optional().describe('世界坐标，厘米'),
    rotation: Rot3.optional().describe('世界旋转，度')
  })
  .describe('一个关键帧。location 和 rotation 至少给一个')

const InputSchema = z.object({
  sequence_path: z
    .string()
    .trim()
    .min(1)
    .describe('目标序列，如 /Game/Cinematics/SQ_Shot01。不存在就新建'),
  camera_label: z
    .string()
    .trim()
    .min(1)
    .describe(
      '相机的 Actor 标签（Outliner 里显示的名字）。' +
        '关卡里已有同名相机就用它，没有就新建一台 CineCameraActor'
    ),
  keys: z.array(KeySchema).min(2).describe('关键帧列表。按 frame 升序，至少两个'),
  fps: z.number().positive().default(30).describe('序列帧率。新建序列时生效'),
  playback_end_frame: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      '播放范围终点，闭开区间 [0, end)。不给就用最后一个关键帧 +1。' +
        '要无缝循环时给「最后一帧 + 1」并且不要在末帧打重复的键'
    ),
  interpolation: z
    .enum(['linear', 'cubic', 'constant'])
    .default('linear')
    .describe('linear=匀速直线；cubic=自动缓入缓出，会在等速运动上造出过冲；constant=跳变不插值'),
  focal_length_mm: z
    .number()
    .positive()
    .optional()
    .describe('相机焦距（毫米）。只在新建相机时设一次，不做变焦动画'),
  replace_existing_keys: z
    .boolean()
    .default(true)
    .describe(
      '这条绑定上已有 Transform 轨道时，先清掉旧的关键帧再写。' +
        '关掉的话新旧键混在一起，通常不是你要的'
    ),
  camera_cuts: z
    .boolean()
    .default(true)
    .describe('顺便建好相机切轨并盖满播放范围。关掉的话渲出来是黑的，除非你另有安排'),
  rebuild_camera_cuts: z
    .boolean()
    .default(false)
    .describe(
      '切轨上已经有段时，允许**把它们全删掉**换成这台相机的一整段。' +
        '默认关闭：那些段可能是排好的多机位剪辑。关着的时候关键帧照写，只是不动切轨'
    )
})

interface CameraKeysOutput {
  sequence_path: string
  camera_label: string
  camera_created: boolean
  sequence_created: boolean
  /** 这条 Transform 轨道写完后的关键帧数，插件从通道读回。旧插件发的是请求里的键数 */
  key_count: number
  /** 这次真正写进去的键数。旧插件不发 */
  written_keys?: number
  /** 没写的键（不是对象、缺 frame、location/rotation 都没给）。旧插件不发 */
  skipped_keys?: number
  /** index 是排好序后发给插件的数组下标 */
  skipped_key_reasons?: { index: number; reason: string }[]
  range: [number, number]
  /** 清掉的旧关键帧数量。0 表示这条轨道原本是空的 */
  replaced_keys: number
  camera_cut_bound: boolean
  /** 切轨上已经有段，这次有意没动它们 */
  kept_existing_cuts: boolean
  /** 这次删掉了几个用户原有的切轨段 */
  removed_cut_sections: number
  level_saved: boolean
  /** 序列资产是否存盘成功。旧插件不发 —— 缺这个字段就当「不知道」，不说已存盘 */
  sequence_saved?: boolean
  warnings?: string[]
  geometry?: { space: 'world'; length_unit: 'cm'; rotation_unit: 'deg' }
}

export function createSequenceCameraKeysTool(): UnrealAgentTool<CameraKeysOutput> {
  return defineTool({
    name: 'sequence_camera_keys',
    namespace: NAMESPACE,
    risk: 'mutating',
    concurrency: 'sequential',
    description: `把一串相机关键帧写进 Level Sequence —— 任意运镜都用这个工具落地。

轨迹由**你**来算：环绕、推轨、跟随、8 字、手持晃动、先升后俯、绕柱螺旋，
都是「一串带位置和朝向的帧」。这个工具不预设任何镜头形状，也不替你选参数。

【怎么用】
1. 需要目标的位置和体积就先 \`ue_get_actor(return_bounds: true)\`
2. 自己算出每一帧的 location / rotation
3. 一次调用写进去：序列不存在会新建，相机不存在会新建，切轨顺带建好

【几件引擎的事，不是审美】
- yaw / roll 要连续累加，不要归一化到 -180..180，否则接缝处画面反甩一圈
- 匀速运动配 cubic 会过冲，用 linear；要缓入缓出才用 cubic
- 播放范围是闭开区间 [0, end)，末帧不渲染。要无缝循环就别在末帧打重复的键
- 新建的 CineCamera 会自动关掉景深（引擎默认对焦 100cm，主体在 5 米外就是糊的）

【会覆盖已有曲线】
写进一条已经有 Transform 关键帧的轨道时，默认先清空再写，返回里报清掉了多少个。
不想覆盖就把 \`replace_existing_keys\` 关掉。

【做不到的】
变焦动画（焦距关键帧）还没有，只能在新建相机时设一个固定焦距。
重定时、可见性/材质等其它轨道也还没有。`,
    input: InputSchema,
    execute: async (input) => {
      // 排序在 TS 侧做：引擎那边按给定顺序打键，乱序会产生错误的插值段
      const sorted = [...input.keys].sort((a, b) => a.frame - b.frame)

      // 同一帧给两个键必须在这里挡掉。引擎的 AddLinearKey / AddCubicKey /
      // AddConstantKey 底下是 InsertKeyInternal，它只做 UpperBound + Insert，
      // **不去重** —— 同帧两个键会两个都留下，切线按零时间差算，
      // 求值取哪个是不定的。做循环时很容易在首尾各打一个同帧的键
      const duplicates = sorted
        .map((k, i) => (i > 0 && k.frame === sorted[i - 1].frame ? k.frame : -1))
        .filter((f) => f >= 0)
      if (duplicates.length > 0) {
        const shown = [...new Set(duplicates)].slice(0, 5).join('、')
        return {
          text:
            `失败：第 ${shown} 帧上给了不止一个关键帧。` +
            `引擎不会去重，两个键都会留下，那条曲线在这一帧的取值是不定的。\n` +
            `每帧只给一个键再调一次。想让镜头在某一帧停住，用两个相邻帧的相同数值，不要用同帧两个键。`,
          isError: true
        }
      }

      const d = await callUe<CameraKeysOutput>(
        'sequence.camera_keys',
        { ...input, keys: sorted },
        { timeoutMs: 120_000 }
      )

      if (!d?.sequence_path) {
        return { text: '失败：引擎没有返回结果', isError: true }
      }

      const lines = [
        '关键帧参照系：world 世界空间；位置 cm，旋转 deg。',
        `${d.sequence_created ? '已新建' : '已写入'} ${d.sequence_path}${
          d.sequence_saved === true
            ? '，序列已存盘'
            : d.sequence_saved === false
              ? '，但序列**没**存盘成功'
              : ''
        }`,
        // 没新建相机就没动过关卡，说「已保存」是假话 —— 那会让用户以为
        // 他关卡里别的未保存改动也落盘了
        `相机：${d.camera_label}（${
          d.camera_created
            ? `新建在关卡里，关卡${d.level_saved ? '已保存' : '**未**保存'}`
            : '复用关卡里已有的，没有改动关卡'
        }）`,
        // key_count 是插件从通道读回的轨道键数。和这次写入的数对不上时两个都报：
        // replace_existing_keys=false 时旧键还在，轨道上的数会更多
        `${
          d.written_keys === undefined || d.written_keys === d.key_count
            ? `${d.key_count} 个关键帧`
            : `写入 ${d.written_keys} 个关键帧，轨道上现有 ${d.key_count} 个`
        }，播放范围 [${d.range[0]}, ${d.range[1]})`
      ]

      // 覆盖了用户的东西必须说，而且要说在前面
      if (d.replaced_keys > 0) {
        lines.push(`⚠️ 这条轨道原有的 ${d.replaced_keys} 个关键帧已被清掉并替换。`)
      }
      if (d.removed_cut_sections > 0) {
        lines.push(`⚠️ 原有的 ${d.removed_cut_sections} 个切轨段已被删除并替换，撤不回来。`)
      }

      // 「有意没动」不能说成「没建成」—— 下一步该做什么完全不一样
      lines.push(
        d.camera_cut_bound
          ? '相机切轨已建好并盖满播放范围。'
          : d.kept_existing_cuts
            ? '切轨上已有的段没有动，所以这台相机还没被切进画面（下面有怎么办）。'
            : '⚠️ 相机切轨没绑上，现在渲出来是黑的。'
      )

      for (const w of d.warnings ?? []) lines.push(`⚠️ ${w}`)

      lines.push('', '跑一次 sequence_audit 确认 PASS 再交给用户。')

      // 有键没写进去时第一句不许是成功（AGENTS.md §5 第 14 条）
      const text = withPartialHeadline(
        lines.join('\n'),
        {
          succeeded: d.written_keys ?? d.key_count,
          failed: 0,
          skipped: d.skipped_keys ?? 0,
          unit: '个关键帧'
        },
        (d.skipped_key_reasons ?? []).map((k) => ({
          item: `按帧排序后的第 ${k.index + 1} 个键`,
          reason: k.reason
        }))
      )

      return {
        text,
        details: { ...d, geometry: { space: 'world', length_unit: 'cm', rotation_unit: 'deg' } }
      }
    }
  })
}
