/**
 * 整关场景 → 控制器能用的东西。
 *
 * 射线和「附近看得见的 Actor」只是角色眼前那一小块。插件的 `pie.scene` 能读到整关：
 * 每个玩法对象的类链、接口、蓝图事件名、蓝图变量当前值、是不是触发区、走不走得到，
 * 还有玩家自己身上的蓝图变量。这里做两件事：
 *
 * 1. 把一个对象压成判定模型读得懂的几行：它是什么、能怎么用、现在什么状态、走不走得到。
 * 2. 对比前后两份快照，说出「这一步之后世界变了什么」—— 谁没了、谁动了、哪个变量变了。
 *    很多游戏根本不打 PrintString，状态只在变量里；「HasKey: false → true」
 *    比等一句打印可靠得多。
 */

import { dirForBearing, type NearbyView } from './controller'
import type { SceneActor, SceneSnapshot } from './types'

/** 引擎自带的父类，说明不了它是什么，不写进提示 */
const GENERIC_CLASSES = new Set(['Actor', 'Pawn', 'Character', 'DefaultPawn', 'StaticMeshActor'])

function stripClass(name: string): string {
  return name.replace(/_C$/, '')
}

/** 组件名是编辑器默认给的（StaticMeshComponent0、Box）就没有语义 */
function meaningfulComponentName(entry: string): string | null {
  const name = entry.split(':')[1] ?? ''
  if (
    !name ||
    /^(DefaultSceneRoot|Root|Scene|StaticMesh|Mesh|Box|Sphere|Capsule|Collision)(Component)?\d*$/i.test(
      name
    )
  ) {
    return null
  }
  if (/Component\d*$/.test(name)) return null
  return name
}

/** 它是什么、能怎么用：类链、接口、事件名、有意义的组件名、标签 */
export function actorHints(actor: SceneActor): string[] {
  const hints: string[] = []
  const parents = actor.parents.map(stripClass).filter((name) => !GENERIC_CLASSES.has(name))
  if (parents.length > 0) hints.push(`kind of ${parents.join(' / ')}`)
  if (actor.interfaces?.length)
    hints.push(`implements ${actor.interfaces.map(stripClass).join(', ')}`)
  if (actor.events?.length) hints.push(`has events ${actor.events.slice(0, 6).join(', ')}`)
  const components = (actor.components ?? []).map(meaningfulComponentName).filter(Boolean)
  if (components.length > 0) hints.push(`parts ${components.slice(0, 5).join(', ')}`)
  if (actor.tags?.length) hints.push(`tags ${actor.tags.join(', ')}`)
  if (actor.trigger) {
    hints.push(actor.reacts_to_overlap ? 'reacts when walked into' : 'is an overlap zone')
  } else if (actor.reacts_to_overlap) {
    hints.push('reacts when touched')
  }
  return hints
}

function distanceBucket(cm: number): NearbyView['distance'] {
  if (cm < 250) return 'touching'
  if (cm < 700) return 'near'
  if (cm < 1500) return 'medium'
  return 'far'
}

/** 场景快照 → 控制器的对象列表（和射线感知出来的「附近」同一个形状，多几个字段） */
export function sceneToNearby(scene: SceneSnapshot): NearbyView[] {
  return scene.actors.map((actor) => {
    const view: NearbyView = {
      name: actor.name,
      class: actor.class,
      where: dirForBearing(actor.bearing),
      distance: distanceBucket(actor.distance),
      meters: Math.round(actor.distance / 10) / 10,
      height: actor.dz > 150 ? 'above' : actor.dz < -150 ? 'below' : 'level',
      visible: true,
      location: actor.location,
      ...(actor.is_pawn ? { is_pawn: true } : {}),
      ...(actor.tags?.length ? { tags: actor.tags } : {})
    }
    const hints = actorHints(actor)
    if (hints.length > 0) view.hints = hints
    if (actor.vars && Object.keys(actor.vars).length > 0) view.state = actor.vars
    if (actor.trigger) view.trigger = true
    if (actor.nav) {
      view.path = actor.nav
      if (actor.path_length !== undefined) view.path_m = Math.round(actor.path_length / 100)
    }
    return view
  })
}

/** 玩家身上的蓝图变量，三处合并（角色、控制器、PlayerState），带上来源前缀避免同名覆盖 */
export function playerVars(scene: SceneSnapshot): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const add = (prefix: string, vars: Record<string, unknown> | undefined): void => {
    for (const [key, value] of Object.entries(vars ?? {})) out[`${prefix}${key}`] = value
  }
  add('', scene.player.pawn_vars)
  add('controller.', scene.player.controller_vars)
  add('state.', scene.player.state_vars)
  return out
}

function short(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 40 ? `${text.slice(0, 37)}...` : text
}

/**
 * 两份快照之间世界变了什么。只报玩法层面的变化：
 * 对象出现 / 消失、挪动超过半米、蓝图变量变了、玩家身上的变量变了。
 *
 * 「出现 / 消失」只看 15 米以内：快照按距离只收最近的一批对象，走动时远处的对象
 * 本来就会进出名单 —— 那不是世界变了，是名单的边界挪了。
 */
export function diffScenes(before: SceneSnapshot, after: SceneSnapshot): string[] {
  const changes: string[] = []
  const prev = new Map(before.actors.map((a) => [a.name, a]))
  const next = new Map(after.actors.map((a) => [a.name, a]))
  const NEAR = 1500

  for (const [name, actor] of prev) {
    const now = next.get(name)
    if (!now) {
      if (actor.distance <= NEAR) changes.push(`${name} disappeared`)
      continue
    }
    const moved = Math.hypot(
      now.location.x - actor.location.x,
      now.location.y - actor.location.y,
      now.location.z - actor.location.z
    )
    if (moved > 50 && !now.is_pawn) changes.push(`${name} moved ${(moved / 100).toFixed(1)} m`)
    for (const [key, value] of Object.entries(now.vars ?? {})) {
      const old = actor.vars?.[key]
      if (old !== undefined && JSON.stringify(old) !== JSON.stringify(value)) {
        changes.push(`${name}.${key}: ${short(old)} → ${short(value)}`)
      }
    }
    if (
      actor.nav &&
      now.nav &&
      actor.nav !== now.nav &&
      (actor.nav === 'partial' || now.nav === 'partial')
    ) {
      changes.push(`path to ${name}: ${actor.nav} → ${now.nav}`)
    }
  }
  for (const [name, actor] of next) {
    if (!prev.has(name) && actor.distance <= NEAR) changes.push(`${name} appeared`)
  }

  const oldVars = playerVars(before)
  for (const [key, value] of Object.entries(playerVars(after))) {
    const old = oldVars[key]
    if (old !== undefined && JSON.stringify(old) !== JSON.stringify(value)) {
      changes.push(`player.${key}: ${short(old)} → ${short(value)}`)
    }
  }
  return changes
}
