/**
 * `sequence_camera_cuts` —— 给一条已有序列补上（或补满）相机切轨。
 *
 * ## 为什么单独一个工具
 *
 * 「Camera Cuts 是空的」和「切轨没盖满播放范围」是黑屏成因里的 A1/A2/A3 ——
 * 三条加起来是最高频的一类。之前它只作为运镜生成的最后一步存在，
 * 于是有两种情况没人管：
 *
 *   1. 生成运镜时编辑器崩在这一步（真机上发生过），关键帧都在、切轨是空的；
 *   2. 序列不是我们生成的 —— 用户自己 K 的相机动画，同样会忘了建切轨。
 *
 * 两种情况用户都被迫回 Sequencer 手点。这个工具就是那两步手工操作。
 *
 * ## 它不做重新绑定
 *
 * possessable 指向一个不存在的对象时（相机被删了、或所在关卡没保存就崩了），
 * 正确做法是 Sequencer 的 **Actions → Advanced → Rebind Possessable References**。
 *
 * 原先不做的理由是「引擎没导出 Python 接口」。**那条理由已经过期** ——
 * 工具集迁到插件 C++ 之后，`UMovieScene::ReplacePossessable` 是够得着的。
 * 现在不做的理由换成了：自动重绑有「该绑到哪一个」的歧义（同名 Actor 有多个、
 * 或者压根不该绑同名的那个），猜错比不修更糟。。
 *
 * 所以这里的选择仍然是**查出来并说清楚怎么点**，而不是假装修好：把切轨绑到一个
 * 解析不到对象的绑定上，渲出来照样是黑的，而用户会以为已经修好了。
 */

import { z } from 'zod'

import { callUe } from '../defineUeTool'
import { defineTool, type UnrealAgentTool } from '../defineTool'

const NAMESPACE = 'ue.sequencer'

const InputSchema = z.object({
  sequence_path: z
    .string()
    .trim()
    .min(1)
    .describe('要处理的序列，如 /Game/Cinematics/SQ_BallOrbit'),
  camera_label: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      '切到哪台相机 —— 填序列里那条绑定的名字（Sequencer 左侧显示的名字）。' +
        '序列里只有一条相机绑定时可以不填，会自动选它'
    )
})

/**
 * 绑定断了时给用户的手动修复步骤。
 *
 * 引擎侧的 `UMovieScene::ReplacePossessable` 现在在 C++ 里够得着了
 * （工具集已从 Python 迁到插件 C++），所以「只能手点」这条**技术上已经不成立**。
 * 但自动重绑有歧义 —— 同名 Actor 有多个、或者根本不该绑到同名的那个 ——
 * 猜错了比不修更糟。做成工具要先设计消歧规则，
 * 的四档方案。在那之前这里仍然只给步骤，不代劳。
 */
const REBIND_STEPS = [
  '这条绑定指向的对象在关卡里已经不存在了，补了切轨照样是黑的。先修绑定：',
  '  1. 打开这条序列，左上角扳手 → Actions → Advanced → Rebind Possessable References',
  '  2. 没生效的话，右键那条相机轨道 → Assign Actor → 选关卡里的那台相机',
  '（自动重绑要先解决「绑到哪一个」的歧义，还没做，所以这一步暂时只能手点。）'
]

interface CameraCutsOutput {
  sequence_path: string
  camera_binding: string
  /** 这次实际写入的切轨范围，闭开区间 */
  range: [number, number]
  /** 本来就盖满了、这次什么都没改 */
  already_covered: boolean
  /** 绑定解析不到对象 —— 补了切轨也还是黑的，必须先手动重绑 */
  binding_broken: boolean
  candidates?: string[]
  warnings?: string[]
}

export function createSequenceCameraCutsTool(): UnrealAgentTool<CameraCutsOutput> {
  return defineTool({
    name: 'sequence_camera_cuts',
    namespace: NAMESPACE,
    risk: 'mutating',
    concurrency: 'sequential',
    description: `给一条已有的 Level Sequence 补上相机切轨（Camera Cuts），让它渲得出画面。

【什么时候用】
- \`sequence_audit\` 报「没有相机切轨」或「切轨没覆盖完播放范围」
- 用户说「渲出来是黑的」「按播放没反应」，而序列里相机动画是有的
- \`sequence_camera_keys\` 在最后一步失败了，只差这条切轨

【它做什么】
找到序列里的相机绑定（只有一台时自动选，多台要你用 camera_label 点名），
建一条盖满播放范围的切轨段并绑上去，然后存盘。已经盖满了就什么都不改。

【它不做什么】
不做 possessable 的重新绑定 —— 自动重绑有「该绑到哪一个」的歧义，还没做。
绑定已经指向不存在的对象时，它会**查出来并告诉你怎么手点**，不会假装修好。`,
    input: InputSchema,
    execute: async (input) => {
      const d = await callUe<CameraCutsOutput>(
        'sequence.camera_cuts',
        { ...input },
        { timeoutMs: 60_000 }
      )

      if (!d?.sequence_path) {
        return { text: '失败：引擎没有返回结果', isError: true }
      }

      const lines = d.already_covered
        ? [`${d.sequence_path} 的相机切轨本来就盖满了 [${d.range[0]}, ${d.range[1]})，没有改动。`]
        : [
            `已给 ${d.sequence_path} 补上相机切轨：`,
            `切到「${d.camera_binding}」，覆盖 [${d.range[0]}, ${d.range[1]})，序列已存盘。`
          ]

      // 绑定是坏的时候，上面那句「已补上」会误导人 —— 必须立刻跟上真相
      if (d.binding_broken) lines.push('', ...REBIND_STEPS)

      for (const w of d.warnings ?? []) lines.push(`⚠️ ${w}`)

      lines.push('', '跑一次 sequence_audit 确认 PASS 再交给用户。')

      return { text: lines.join('\n'), details: d }
    }
  })
}
