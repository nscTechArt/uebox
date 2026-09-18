/**
 * 「这次读/写的是哪个世界」—— 插件返回里那三个字段的统一透传。
 *
 * ## 为什么需要它
 *
 * 游戏跑起来（PIE）之后，同一个关卡在内存里有**两份**：编辑器里那份没在动的，
 * 和正在跑的那份。在 2026-09-03 之前，除截图外每一条命令读的都是前者 ——
 * 于是「玩家现在在哪」「门开了吗」「生成了几个敌人」全都回答的是关卡模板，
 * **而且不报错**。模型据此下运行时结论，得到的是看起来成功的错误答案。
 *
 * 插件侧已经改成自动读正在跑的那个世界。但只改插件不够：工具返回是白名单式
 * 构造的，不显式透传的字段模型根本看不到。看不到 `world`，它就分不清
 * 「这个 Actor 不存在」和「它在另一个世界里」—— 而 PIE 一开一关，
 * 同一条查询会给出两个不同的答案。
 *
 * ## 为什么 note 要拼进 message 而不是只留字段
 *
 * 和 `ue_screenshot` 把「这张图是游戏还是编辑器」写进 message 是同一个理由：
 * 模型不一定逐条看返回字段，而「改动会不会留下」直接决定它该怎么跟用户说。
 * 只给一个 `world: "pie"` 字段，它多半会把「改成功了」原样转述，
 * 而那个改动在用户按下停止的瞬间就没了。
 */

export interface WorldScopedResponse {
  /** `pie` = 正在跑的游戏世界；`editor` = 编辑器世界 */
  world?: string
  /** PIE 时插件给的一句人话：改动不落盘、停止就没了 */
  world_note?: string
  /** 多客户端 PIE 时 > 1 */
  play_world_count?: number
}

/**
 * 透传世界字段。老插件不回这些字段时**一个字都不加** ——
 * 说不准的时候不说，比默认写成「编辑器世界」强，那是在替插件编一个没确认的事实。
 */
export function worldFields(response: WorldScopedResponse | undefined): WorldScopedResponse {
  if (!response?.world) return {}
  return {
    world: response.world,
    ...(response.world_note ? { world_note: response.world_note } : {}),
    ...(response.play_world_count !== undefined
      ? { play_world_count: response.play_world_count }
      : {})
  }
}

/**
 * 拼在 message 后面的一句话。
 *
 * 只在 PIE 时才说：编辑器世界是默认情况，每条返回都加一句「这是编辑器世界」
 * 属于噪音，说多了模型就不看了。
 */
export function describeWorld(response: WorldScopedResponse | undefined): string {
  if (response?.world !== 'pie') return ''

  const multi =
    response.play_world_count && response.play_world_count > 1
      ? `（当前有 ${response.play_world_count} 个游戏实例，这个结论只针对其中一个）`
      : ''

  return `\n\n⚠️ 游戏正在运行，以上针对的是**正在跑的游戏世界**，不是关卡里的原始摆放${multi}。${
    response.world_note ?? ''
  }`
}
