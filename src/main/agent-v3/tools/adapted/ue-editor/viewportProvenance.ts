/**
 * 记住关卡视口最后一次是被谁、什么时候、用什么调用挪动的。
 *
 * ## 为什么要记
 *
 * 真机上模型用 Python 把视口相机指向了天空（Rotator 位置参数错序），接着
 * `ue_screenshot` 拍回一整张云。返回里那句「仰视 90°」最后救了场，但中间
 * 白花了一次截图和两次重摆镜头 —— 因为**没有任何一次调用告诉过它「你刚动过
 * 用户的视口」**。它把云当成了「场景没了」而不是「镜头被我自己写坏了」。
 *
 * 所以每个会动视口的工具在动完之后打一条记录，`ue_screenshot` 拍视口那一帧时
 * 把它拼进返回：「视口最后一次是 12 秒前由 ue_run_python_script 改的
 * （脚本里调了 set_level_viewport_camera_info）」。看到这一句，模型第一反应
 * 就该是回头查自己那行代码，而不是怀疑场景。
 *
 * 只记盒子这边发出的调用。用户自己拖视口这一层看不见，所以措辞永远留一句
 * 「此后用户也可能动过」—— 说不准的时候不说死。
 */

export interface ViewportMoveRecord {
  /** 发起调用的工具名，例如 `ue_focus_viewport` */
  tool: string
  /** 一句人话，说清是怎么动的 */
  detail: string
  /** 毫秒时间戳 */
  at: number
}

let last: ViewportMoveRecord | null = null

/** 动完视口之后调一次。detail 直接拼进截图返回，写成人能读的一句 */
export function noteViewportMove(tool: string, detail: string, now = Date.now()): void {
  last = { tool, detail, at: now }
}

export function lastViewportMove(): ViewportMoveRecord | null {
  return last
}

/** 测试用 */
export function resetViewportProvenance(): void {
  last = null
}

/**
 * Python 脚本里会动关卡视口相机的那几个入口。
 * 命中就记一条 —— 不管脚本最终跑成没跑成都记，因为「跑成了但改坏了」正是要抓的情形；
 * 没跑成的那次多记一条，代价只是截图里多一句话。
 */
const VIEWPORT_CAMERA_APIS = [
  'set_level_viewport_camera_info',
  'set_viewport_camera',
  'pilot_level_actor',
  'editor_set_camera_look_at_location'
]

/** 脚本里调了哪个视口相机 API；没调返回 null */
export function viewportCameraApiInScript(script: string): string | null {
  for (const api of VIEWPORT_CAMERA_APIS) {
    if (script.includes(api)) return api
  }
  return null
}

const describeAge = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒前`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} 分钟前`
  return `${Math.round(m / 60)} 小时前`
}

/**
 * 拼给 `ue_screenshot` 的那一句。没有记录返回空串 —— 说不准的时候不说。
 */
export function describeViewportProvenance(now = Date.now()): string {
  if (!last) return ''
  return (
    `\n视口最后一次是 ${describeAge(now - last.at)}由 ${last.tool} 改的（${last.detail}）；` +
    `此后用户也可能自己动过。画面不对劲先回头查那次调用，再怀疑场景。`
  )
}
