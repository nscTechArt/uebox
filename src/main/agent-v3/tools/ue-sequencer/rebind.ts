/**
 * `sequence_rebind` —— 把一条 possessable 绑定改指向关卡里的某个 Actor。
 *
 * ## 为什么之前没做、现在做了
 *
 * 绑定断了（相机被删、Actor 改名后重放、关卡另存）以后，那条轨道什么都不做，
 * 渲出来是黑的或者东西不动。以前只能给用户手点的步骤：
 * 先说「没有 Python 接口」，迁到插件 C++ 之后那条理由不成立了，剩下的顾虑是
 * 「该绑到哪一个」的歧义 —— 同名 Actor 有多个，或者根本不该绑同名的那个。
 *
 * 这个工具的消歧规则就是**不猜**：
 *
 *   - Actor 必须由调用方点名（标签、对象名或完整路径）。点到多个就拒绝，把候选
 *     连同路径一起列回去；
 *   - 绑定名撞了同样回候选，用 guid 点名；
 *   - 新 Actor 不是原类型的子类先拒绝（轨道上的属性多半对不上），
 *     确认要换带 `allow_class_change`；
 *   - Actor 已经被这条序列的另一条绑定占着也拒绝 —— 两条绑定抢一个对象，轨道互相覆盖。
 *
 * 组件绑定不直接重绑：它们相对父 Actor 解析，父那条绑对了，同名组件自动跟上；
 * 跟不上的（新 Actor 上没有同名组件）在回执里逐条报。GUID 不变，切轨和子序列的引用不用修。
 */

import { z } from 'zod'

import { callUe } from '../defineUeTool'
import { defineTool, type UnrealAgentTool } from '../defineTool'

const NAMESPACE = 'ue.sequencer'

const InputSchema = z.object({
  sequence_path: z.string().trim().min(1).describe('要修的序列，如 /Game/Cinematics/SQ_Intro'),
  binding: z
    .string()
    .trim()
    .min(1)
    .describe(
      '要重绑的那条绑定：Sequencer 左侧显示的名字，或 sequence_describe 给的 guid。' +
        '同名的绑定不止一条时必须用 guid'
    ),
  actor: z
    .string()
    .trim()
    .min(1)
    .describe(
      '绑到关卡里哪个 Actor：大纲里的标签、对象名或完整路径都行。' +
        '同名的有好几个时会被拒绝并列出候选，再用其中一个的 path 点名'
    ),
  allow_class_change: z
    .boolean()
    .default(false)
    .describe(
      '新 Actor 不是原来那个类（或其子类）时也照样绑。默认拒绝：' +
        '比如原来绑 CineCameraActor 的轨道，换成普通 CameraActor 后焦距那些轨道就作用不上了'
    )
})

interface RebindOutput {
  sequence_path: string
  binding_guid: string
  /** 重绑前的绑定名 */
  previous_name: string
  /** 重绑后的绑定名（跟着新 Actor 的标签走，和编辑器 Assign Actor 一致） */
  binding_name: string
  /** 重绑前这条绑定是不是已经解析不到对象 */
  was_broken: boolean
  /** 重绑前它指向的 Actor。断了、或这台引擎判不出来时没有 */
  previous_actor?: string
  actor_label: string
  actor_path: string
  actor_class: string
  /** 写完读回来是否解析到这个 Actor。这台引擎判不出时不发 */
  resolved?: boolean
  /** 子组件绑定里在新 Actor 上找不到同名组件的 */
  broken_components: string[]
  sequence_saved: boolean
  warnings?: string[]
}

export function createSequenceRebindTool(): UnrealAgentTool<RebindOutput> {
  return defineTool({
    name: 'sequence_rebind',
    namespace: NAMESPACE,
    risk: 'mutating',
    concurrency: 'sequential',
    description: `把 Level Sequence 里一条 possessable 绑定改指向关卡里的某个 Actor（编辑器里的 Assign Actor）。

【什么时候用】
- \`sequence_audit\` / \`sequence_describe\` 报「绑定已失效」：相机被删了重放、Actor 改了名、关卡另存了
- 用户要把一条轨道换给另一个 Actor（「这段动画给 BP_Hero2 用」）

【怎么点名】
binding 填绑定名（或 guid），actor 填关卡里 Actor 的标签 / 对象名 / 完整路径。
**它不猜**：同名的 Actor 或绑定不止一个时直接拒绝，把候选列回来 —— 拿不准该绑哪个就问用户，
别从候选里随手挑一个。

【会被拒的情况】
- 新 Actor 不是原来那个类的子类（带 allow_class_change=true 才换，先跟用户确认）
- 这个 Actor 已经被同一条序列的另一条绑定绑着
- 组件绑定（挂在某个 Actor 下面的那种）：重绑它的父绑定，同名组件会跟着过去
- 生成体（spawnable）：对象由序列自己生成，没有可重绑的东西

【做完】
绑定的 GUID 不变，切轨和子序列的引用不用修；绑定名改成新 Actor 的标签；序列存盘。
新 Actor 上找不到同名组件的子绑定会逐条报出来，那几条要另外处理。`,
    input: InputSchema,
    execute: async (input) => {
      const d = await callUe<RebindOutput>('sequence.rebind', { ...input }, { timeoutMs: 60_000 })

      if (!d?.binding_guid) {
        return { text: '失败：引擎没有返回结果', isError: true }
      }

      const from = d.was_broken
        ? '（原来已失效）'
        : d.previous_actor
          ? `（原来指向「${d.previous_actor}」）`
          : ''
      const rename =
        d.binding_name && d.binding_name !== d.previous_name
          ? `，绑定名「${d.previous_name}」→「${d.binding_name}」`
          : ''
      const saveNote = d.sequence_saved
        ? '序列已存盘。'
        : '⚠️ 序列**没**存盘成功，改动只在编辑器内存里，关掉编辑器前要手动保存。'

      const lines = [
        `已把 ${d.sequence_path} 的绑定「${d.previous_name}」${from}改绑到 ` +
          `${d.actor_label}（${d.actor_class}，${d.actor_path}）${rename}。${saveNote}`
      ]

      const broken = d.broken_components ?? []
      if (broken.length > 0) {
        lines.push(
          `⚠️ ${broken.length} 条组件子绑定在新 Actor 上找不到同名组件，现在是断的：` +
            `${broken.join('、')}。这些轨道不会生效。`
        )
      }

      for (const w of d.warnings ?? []) lines.push(`⚠️ ${w}`)

      lines.push('', '跑一次 sequence_audit 确认绑定都解析得到。')

      return { text: lines.join('\n'), details: d }
    }
  })
}
