/**
 * 关卡的**组成**：这个世界由哪几层关卡拼出来，各自在编辑器和游戏里是什么状态。
 *
 * ## 补的是哪个洞
 *
 * 「编辑器里好好的，一按 Play 就不一样」是最常撞上的一类问题，头号成因是
 * 子关卡的**编辑器可见**和**游戏加载**本来就是两个独立开关。而在这两个工具
 * 之前，整套工具链答不出「当前世界由哪些关卡组成」——`ue_get_actor` 只能查
 * Actor，`ue_get_current_level` 只回当前那一张。
 *
 * 真实案例（2026-09-07）：Studio 关卡的灰色影棚背景、地面和后期处理体积全在
 * 挂进来的 `L_BaseEnvironment` 子关卡里。编辑器视口正常，PIE 里背景纯黑。
 * 材质图、bHidden、构造脚本被逐个排除之后，排查卡死在「要验证但没手段」——
 * 而这件事在用户的 Levels 窗格里一直是明摆着的。
 *
 * ## 为什么读和写一起给
 *
 * 只给读的话，模型能诊断却改不了，只能请用户自己去点 Levels 窗格 ——
 * 那正是那次真实发生的事。诊断和修复要在同一条链上。
 */

import { defineV2Tool } from '../../adaptV2Tool'
import { z } from 'zod'
import { serviceManager } from '../../../../services'

import { getTargetConnectionId } from '../../../core/projectTargetContext'
import { describeWorld, worldFields, type WorldScopedResponse } from '../../worldScope'
import { UE_NOT_CONNECTED_MESSAGE } from '../../defineUeTool'

/** 一个子关卡的全部状态，字段与插件 `UAL_StreamingLevelJson` 一一对应 */
export interface StreamingLevelInfo {
  package: string
  name: string
  /** `LevelStreamingAlwaysLoaded` / `LevelStreamingDynamic` / 用户自定义子类 */
  streaming_class: string
  always_loaded: boolean
  should_be_loaded: boolean
  should_be_visible: boolean
  /** 引擎算过的最终结论：`should_be_visible && should_be_loaded` */
  visible_at_runtime: boolean
  visible_in_editor: boolean
  is_loaded: boolean
  is_visible: boolean
  actor_count?: number
  mismatch: 'none' | 'editor_only' | 'game_only'
  /**
   * `editor_only` 时才有，说的是**哪一种** editor_only：
   * `not_loaded` 这一层游戏里根本不加载（改流送方式）；
   * `loaded_but_hidden` 加载了、在跑，只是没显示（改 should_be_visible）。
   * 两种病的药不一样，混在一起说会让调用方对第二种一直开 always_loaded。
   */
  mismatch_reason?: 'not_loaded' | 'loaded_but_hidden'
}

interface ListLevelsResponse extends WorldScopedResponse {
  ok: boolean
  persistent?: { package: string; name: string; actor_count: number }
  is_world_partition?: boolean
  streaming_level_count?: number
  streaming_levels?: StreamingLevelInfo[]
  editor_only_levels?: string[]
  game_only_levels?: string[]
  /** WP 运行时自动生成的格子数。它们不进上面那些清单，理由见插件侧同名注释 */
  world_partition_runtime_cells?: number
}

interface SetStreamingResponse {
  ok: boolean
  level?: string
  before?: StreamingLevelInfo
  after?: StreamingLevelInfo
  changed?: string[]
  undoable?: boolean
  needs_save?: boolean
}

function requireConnection(): { success: false; error: string } | null {
  if (serviceManager.getWebSocketService().getConnectionCount() === 0) {
    return {
      success: false,
      error: UE_NOT_CONNECTED_MESSAGE
    }
  }
  return null
}

/**
 * 把关卡清单读成一句结论。
 *
 * 不写这一段的话，模型拿到的是一个二十行的数组，而「哪一层对不上」正是这条
 * 命令的全部价值 —— 埋在数组里等于没给。尤其 `editor_only`：它是
 * 「PIE 里东西不见了」的头号答案，必须直接说出来，还要带上怎么改。
 */
function summarizeLevels(response: ListLevelsResponse): string {
  const persistent = response.persistent
  const count = response.streaming_level_count ?? 0
  const parts: string[] = [
    `持久关卡 ${persistent?.package ?? '未知'}（${persistent?.actor_count ?? 0} 个 Actor），${count} 个流送子关卡`
  ]

  if (response.is_world_partition) {
    // WP 图不走手工挂子关卡那套，0 不代表「只有一层」。
    // 运行时它会把自动生成的格子塞进同一个数组，那些格子不参与下面的判定
    parts.push(
      '这是 World Partition 关卡 —— 内容按空间网格自动分块，运行时加载哪些格子' +
        '由距离和数据层决定，不归子关卡那几个标志管。手工挂的子关卡数为 0 是正常的' +
        (response.world_partition_runtime_cells
          ? `；运行时另有 ${response.world_partition_runtime_cells} 个自动生成的格子，` +
            '它们是临时对象，不列进下面的清单，也不该去改它们的流送设置'
          : '')
    )
  }

  const editorOnly = response.editor_only_levels ?? []
  if (editorOnly.length > 0) {
    // 分两种病开两种药。混着说的话，「加载了只是没显示」那种会被一直开
    // always_loaded —— 而那个开关碰都碰不到 should_be_visible
    const byName = new Map(
      (response.streaming_levels ?? []).map((level) => [level.name, level.mismatch_reason])
    )
    const notLoaded = editorOnly.filter((name) => byName.get(name) !== 'loaded_but_hidden')
    const hidden = editorOnly.filter((name) => byName.get(name) === 'loaded_but_hidden')

    if (notLoaded.length > 0) {
      parts.push(
        `**${notLoaded.length} 个子关卡在编辑器里看得见，游戏里不会加载**：${notLoaded.join('、')}。` +
          '这就是「编辑器里好好的、PIE 里东西不见了」最常见的原因 —— ' +
          '不是材质、不是 bHidden，是这一层压根没进游戏世界。' +
          '要让它进游戏，用 ue_set_level_streaming 把它设成 always_loaded=true。'
      )
    }
    if (hidden.length > 0) {
      parts.push(
        `**${hidden.length} 个子关卡游戏里会加载、但不显示**：${hidden.join('、')}。` +
          '它们在游戏里是活的（Actor、碰撞、关卡蓝图都在跑），只是看不见。' +
          '这种要改的是 should_be_visible=true，**不是** always_loaded —— ' +
          '换流送方式碰不到这个标志，改了也白改。'
      )
    }
  }

  const gameOnly = response.game_only_levels ?? []
  if (gameOnly.length > 0) {
    parts.push(
      `${gameOnly.length} 个子关卡在编辑器里被藏着但游戏里会出现：${gameOnly.join('、')}。` +
        '摆位置时看不见它们，跑起来会突然冒出来。'
    )
  }

  if (count > 0 && editorOnly.length === 0 && gameOnly.length === 0) {
    parts.push('编辑器与游戏两边的可见性一致，没有对不上的子关卡')
  }

  return parts.join('；\n\n') + describeWorld(response)
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createGetLevelsTool() {
  return defineV2Tool({
    description: `列出当前世界由哪些关卡组成：持久关卡 + 每个流送子关卡的加载和可见标志。

**「编辑器里是这样，运行起来不是这样」先查这个。** 子关卡的「编辑器可见」和
「游戏加载」是两个独立开关，默认值还不一样 —— 一层在视口里看得见、在 PIE 里
根本不加载，是完全正常的默认状态。背景、地面、光照、后期处理体积经常整层
挂在子关卡里，这一层不加载，游戏里就是一片黑。

去翻材质、bHidden、构造脚本之前先来这里：那几样都是每次排查最容易白走的路。

每个子关卡返回：
- **mismatch**：\`editor_only\` = 编辑器看得见但游戏里看不见（就是上面那个坑）；
  \`game_only\` = 编辑器里藏着但游戏里会出现；\`none\` = 两边一致。
- **mismatch_reason**（只在 editor_only 时有）：\`not_loaded\` 这一层游戏里根本不加载，
  改 always_loaded=true；\`loaded_but_hidden\` 加载了、在跑，只是没显示，
  改 should_be_visible=true。**两种的药不一样**，别一律上 always_loaded。
- **always_loaded**：流送方式。false 表示要靠蓝图或流送体积去加载它，
  没人加载它就永远不出现。
- should_be_loaded / should_be_visible / visible_at_runtime：游戏侧的意图。
- visible_in_editor / is_loaded / is_visible：编辑器侧和此刻的实况。
- actor_count：这一层里有多少 Actor（只在已加载时有）。

顶上的 editor_only_levels / game_only_levels 是点名清单，直接看它就够。

**is_world_partition=true 时子关卡数为 0 是正常的** —— WP 关卡按空间网格分块，
不走流送子关卡那套，运行时加载哪些格子由距离和数据层决定。跑着的时候
world_partition_runtime_cells 会告诉你有多少个自动生成的格子；那些是临时对象，
不参与上面的判定，也不要去改它们的流送设置（改不着，只会报找不到）。

游戏跑着的时候读的是正在跑的那个世界，也就是「游戏里实际加载了哪几层」。`,
    inputSchema: z.object({}),
    execute: async () => {
      const notConnected = requireConnection()
      if (notConnected) return notConnected
      try {
        const response = await serviceManager
          .getWebSocketService()
          .callRequest<ListLevelsResponse>('level.list', {}, getTargetConnectionId(), 30000)

        if (!response || !response.ok) {
          const message = (response as unknown as { error?: string })?.error || '拿不到关卡列表'
          return { success: false, error: message }
        }

        return {
          success: true,
          persistent: response.persistent,
          is_world_partition: response.is_world_partition,
          streaming_level_count: response.streaming_level_count,
          streaming_levels: response.streaming_levels ?? [],
          editor_only_levels: response.editor_only_levels ?? [],
          game_only_levels: response.game_only_levels ?? [],
          ...worldFields(response),
          summary: summarizeLevels(response)
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}

const SetStreamingSchema = z.object({
  level: z.string().describe('子关卡的短名（L_BaseEnvironment）或完整包路径。重名时必须给完整路径'),
  always_loaded: z
    .boolean()
    .optional()
    .describe(
      '流送方式。true = 固定加载（游戏一开始就在，等同 Levels 窗格选 Always Loaded）；' +
        'false = 改回动态流送，要靠蓝图或流送体积去加载。' +
        '这一项**换的是流送对象本身，进不了撤销栈**，改回来要再调一次'
    ),
  should_be_loaded: z
    .boolean()
    .optional()
    .describe('游戏里是否加载这一层。固定加载的关卡恒为 true，写 false 无效'),
  should_be_visible: z.boolean().optional().describe('游戏里加载之后是否可见'),
  visible_in_editor: z
    .boolean()
    .optional()
    .describe('编辑器视口里是否显示这一层（Levels 窗格里的眼睛）')
})

/**
 * 改动结果只报回读值。
 *
 * 「设进去了」和「生效了」是两回事：`ULevelStreamingAlwaysLoaded` 上的
 * should_be_loaded 永远是 true，写 false 进去它照样是 true。照着入参说
 * 「已设为 false」就是在编一个没发生的事实。
 */
function summarizeChange(input: { level: string }, response: SetStreamingResponse): string {
  const after = response.after
  const before = response.before
  if (!after) {
    return `${input.level} 的流送设置已提交，但插件没回读到状态 —— 没有确认上，请用 ue_get_levels 自己核一遍`
  }

  const lines = [
    `${after.package}：` +
      `流送方式 ${before?.streaming_class ?? '?'} → ${after.streaming_class}，` +
      `游戏里可见 ${before?.visible_at_runtime ?? '?'} → ${after.visible_at_runtime}，` +
      `编辑器里可见 ${before?.visible_in_editor ?? '?'} → ${after.visible_in_editor}`
  ]

  // 一件都没真改到。恒说「已修改」会让调用方以为问题解决了
  if ((response.changed?.length ?? 0) === 0) {
    lines.push(
      '⚠️ **实际上什么都没变** —— 传的值和原来一样，或者引擎不接受这次写入' +
        '（比如固定加载的关卡上 should_be_loaded 恒为 true，写 false 无效）。' +
        '工程没有被改脏，也不用保存。'
    )
  }

  if (after.mismatch === 'editor_only') {
    // 两种病分开开药。不分的话「加载了只是没显示」那种会被一直开 always_loaded，
    // 而那个开关根本碰不到 should_be_visible，于是回读永远对不上、模型永远重试
    lines.push(
      after.mismatch_reason === 'loaded_but_hidden'
        ? '⚠️ 改完之后这一层**游戏里会加载、但仍然不显示**。' +
            '要让它显示，改的是 should_be_visible=true —— always_loaded 碰不到这个标志。'
        : '⚠️ 改完之后这一层**仍然是编辑器可见、游戏里不加载**。' +
            '如果目的是让它在游戏里出现，要 always_loaded=true（或者 should_be_loaded 和 ' +
            'should_be_visible 同时为 true）'
    )
  }

  if (response.undoable === false) {
    // 「再调一次就回去了」是假的：换类会新建一个 ULevelStreamingDynamic，
    // 而它的两个游戏侧标志默认全 false。插件现在会把原值接回来，
    // 但那是插件在兜底，不是引擎的语义 —— 话不能说成「随便改，反正撤得回」
    lines.push(
      '这次改的是流送方式，**Ctrl+Z 撤不回来**。要还原就再调一次这个工具并把 ' +
        'always_loaded 传回原值；改完务必用 ue_get_levels 核一遍回到了原来的状态。'
    )
  }

  // 流送设置存在持久关卡的包里。不说这句，用户重开工程会发现改动没了
  if (response.needs_save !== false) {
    lines.push('流送设置存在持久关卡里，记得 ue_save_level，否则重开工程就回到原样')
  }

  return lines.join('\n\n')
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createSetLevelStreamingTool() {
  return defineV2Tool({
    description: `改一个流送子关卡的加载方式和可见标志，等同于用户在 Levels 窗格里点那几个勾。

先用 ue_get_levels 看清楚现状再改，**按 mismatch_reason 决定改哪个开关**：
- \`not_loaded\`（游戏里根本不加载）→ always_loaded=true
- \`loaded_but_hidden\`（加载了但没显示）→ should_be_visible=true。
  这种情况下 always_loaded 是无效的，它碰不到显示标志。

几件要先知道的事：
- **always_loaded 改的是流送对象本身，Ctrl+Z 撤不回来。** 要还原就再调一次
  并把 always_loaded 传回原值，然后用 ue_get_levels 核一遍真的回去了。
  其余三个标志是普通属性改动，可以撤销。
- 换流送方式要求这一层此刻是加载着的。没加载的话，**在同一次调用里一起传
  visible_in_editor=true** 就行，它会先把关卡加载出来。
- 固定加载的关卡 should_be_loaded 恒为 true，写 false 不会生效 ——
  返回里报的是**回读值**，\`changed\` 也只列真的变了的字段。
  changed 是空数组就表示这次什么都没改到，工程也没被改脏。
- 流送设置存在持久关卡的包里，改完要 ue_save_level 才留得住。
- 游戏跑着的时候会被拒绝：这是编辑器动作，PIE 里改了按停止就没了。`,
    inputSchema: SetStreamingSchema,
    execute: async (input) => {
      const notConnected = requireConnection()
      if (notConnected) return notConnected
      try {
        const params: Record<string, unknown> = { level: input.level }
        if (input.always_loaded !== undefined) params.always_loaded = input.always_loaded
        if (input.should_be_loaded !== undefined) params.should_be_loaded = input.should_be_loaded
        if (input.should_be_visible !== undefined)
          params.should_be_visible = input.should_be_visible
        if (input.visible_in_editor !== undefined)
          params.visible_in_editor = input.visible_in_editor

        const response = await serviceManager
          .getWebSocketService()
          .callRequest<SetStreamingResponse>(
            'level.set_streaming',
            params,
            getTargetConnectionId(),
            60000
          )

        if (!response || !response.ok) {
          const raw = response as unknown as {
            error?: string
            details?: { available_levels?: string[] }
          }
          const available = raw?.details?.available_levels
          const hint =
            available && available.length > 0
              ? `\n\n这张图里的流送子关卡：\n  ${available.join('\n  ')}`
              : ''
          return { success: false, error: (raw?.error || '改流送设置失败') + hint }
        }

        return {
          success: true,
          level: response.level,
          before: response.before,
          after: response.after,
          changed: response.changed ?? [],
          undoable: response.undoable,
          needs_save: response.needs_save,
          summary: summarizeChange(input, response)
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  })
}
