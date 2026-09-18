/**
 * UE 的旋转是 (Pitch, Yaw, Roll) 三个角度。这个模块负责把它翻译成人话，并让回读自带含义。
 *
 * ## 为什么值得单开一个模块
 *
 * 真机任务里栽过一次：从零搭湖景别墅，方向光被设成 `(Pitch=30, Yaw=180, Roll=-135)`。
 * Pitch 为正在 UE 里是**仰照**，光从地底往上打，画面整体发灰；Roll 对方向光毫无意义。
 * 用户点了两次才纠正过来，最终 `(Pitch=-8, Yaw=-30, Roll=0)` 才是暖金黄昏。
 *
 * 值得记的不是「有人把正负号搞反了」，而是**为什么连着几轮都没发现**：
 *
 * - 旋转类返回体是三个**裸数字**。`Pitch=30` 在「太阳高度 30°」这种直觉读法下完全合理，
 *   在 UE 的约定下却是反的 —— 返回体里没有任何东西能把这两种读法分开。
 * - 于是自检只能做成「我填的和我读回的一致吗」。一致，但同错。
 *   **自洽性校验对约定错误是结构性失明的**，和米/厘米那次（见 `ueUnits.ts`）是同一类事。
 * - 截图救不了：SceneCapture 曝光和视口不一致，模型对着偏差图越调越偏。
 *
 * 所以修法不是提示词里多写一句「注意 pitch 正负」，而是**让旋转自己说出它朝哪**：
 * 方向光回「太阳高度角 8°，光往 +X 偏 -Y 方向斜射下来」，pitch 为正直接标 ⚠️。
 * 再往前一步，让调用方能直接说「太阳高度 8°、方位 300°」，由这里算成旋转，
 * 从根上不给正负号出错的机会。
 *
 * 换更强的模型会少错，但没有回读任何模型都是盲飞。这一层对模型强弱一视同仁。
 *
 * ## UE 的约定（这里的一切都以此为准）
 *
 * - 局部 +X 是「正面 / 朝向」，+Y 是右，+Z 是上。左手系。
 * - Pitch 绕 Y：**正值抬头**（+X 朝上翘），负值低头。
 * - Yaw 绕 Z：0 = +X 方向，90 = +Y 方向，从上往下看是顺时针。
 * - Roll 绕 X：正值右倾（右侧往下压）。
 * - 灯光、相机、SceneCapture 都沿自己的 +X 发射/看出去。所以**方向光的太阳高度角 = -Pitch**。
 *
 * 用在 `ue_set_transform` / `ue_get_actor` / `ue_spawn_actor` / `ue_focus_viewport` / `ue_screenshot`。
 */

export interface RotatorLike {
  pitch?: number
  yaw?: number
  roll?: number
}

export interface Rotator {
  pitch: number
  yaw: number
  roll: number
}

export interface Vec3Like {
  x?: number
  y?: number
  z?: number
}

export interface Vec3 {
  x: number
  y: number
  z: number
}

const DEG = Math.PI / 180

const num = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const round1 = (value: number): number => Math.round(value * 10) / 10

/** 把角度归一到 (-180, 180] */
export function normalizeDegrees(deg: number): number {
  let d = ((((deg + 180) % 360) + 360) % 360) - 180
  if (d === -180) d = 180
  return d
}

/**
 * UE `FRotationMatrix`：旋转后的三根局部轴在世界里的方向。
 * 公式逐字来自引擎源码 `FRotationTranslationMatrix`，别按别的引擎的顺序改。
 */
export function rotatorToAxes(rot: RotatorLike): { forward: Vec3; right: Vec3; up: Vec3 } {
  const p = num(rot.pitch) * DEG
  const y = num(rot.yaw) * DEG
  const r = num(rot.roll) * DEG
  const SP = Math.sin(p)
  const CP = Math.cos(p)
  const SY = Math.sin(y)
  const CY = Math.cos(y)
  const SR = Math.sin(r)
  const CR = Math.cos(r)
  return {
    forward: { x: CP * CY, y: CP * SY, z: SP },
    right: { x: SR * SP * CY - CR * SY, y: SR * SP * SY + CR * CY, z: -SR * CP },
    up: { x: -(CR * SP * CY + SR * SY), y: CY * SR - CR * SP * SY, z: CR * CP }
  }
}

/**
 * 一个世界方向向量 → 让 +X 指向它的旋转。Roll 恒为 0。
 * 零向量没有方向，返回 null 让调用方报错，别默默给个 (0,0,0)。
 */
export function directionToRotator(dir: Vec3Like): Rotator | null {
  const x = num(dir.x)
  const y = num(dir.y)
  const z = num(dir.z)
  const len = Math.hypot(x, y, z)
  if (len < 1e-6) return null
  return {
    pitch: round1(Math.asin(z / len) / DEG),
    yaw: round1(Math.atan2(y, x) / DEG),
    roll: 0
  }
}

export interface SunInput {
  /** 太阳离地平线多高：0 = 贴地平线，90 = 头顶正上方。黄昏 5～15，正午 60～90 */
  elevation: number
  /** 太阳在哪个方位：0 = +X 方向，90 = +Y 方向，180 = -X，270（或 -90）= -Y。不给默认 0 */
  azimuth?: number
}

/**
 * 方向光：太阳位置 → 灯的旋转。
 *
 * 光从太阳射向地面，所以灯的 +X 指向太阳的**反方向**：pitch = -elevation，yaw = azimuth + 180。
 * 这一步就是那次事故里出错的那一步，交给代码算，模型只说太阳在哪。
 */
export function sunToRotator(sun: SunInput): Rotator {
  const elevation = num(sun.elevation)
  const azimuth = num(sun.azimuth)
  return {
    pitch: round1(-elevation),
    yaw: round1(normalizeDegrees(azimuth + 180)),
    roll: 0
  }
}

/** 反算：灯的旋转 → 太阳在哪。elevation ≤ 0 就是太阳在地平线以下 */
export function rotatorToSun(rot: RotatorLike): { elevation: number; azimuth: number } {
  const { forward } = rotatorToAxes(rot)
  // 太阳在光的来处，也就是 -forward
  const sun = { x: -forward.x, y: -forward.y, z: -forward.z }
  return {
    elevation: round1(Math.asin(Math.max(-1, Math.min(1, sun.z))) / DEG),
    azimuth: round1(normalizeDegrees(Math.atan2(sun.y, sun.x) / DEG))
  }
}

const axisName = (axis: 'x' | 'y', sign: number): string =>
  `${sign < 0 ? '-' : '+'}${axis.toUpperCase()}`

/**
 * 水平方向说成「+X 偏 -Y 30°」。
 * 用轴名而不用东南西北：UE 没有内建罗盘，哪边是北取决于关卡怎么摆，说了反而误导。
 */
export function describeHeading(v: Vec3Like): string {
  const x = num(v.x)
  const y = num(v.y)
  if (Math.hypot(x, y) < 1e-6) return '（无水平分量）'
  const primaryIsX = Math.abs(x) >= Math.abs(y)
  const primary = primaryIsX ? axisName('x', x) : axisName('y', y)
  const secondary = primaryIsX ? axisName('y', y) : axisName('x', x)
  const off =
    Math.atan(Math.min(Math.abs(x), Math.abs(y)) / Math.max(Math.abs(x), Math.abs(y))) / DEG
  if (off < 2.5) return `${primary} 方向`
  return `${primary} 偏 ${secondary} ${Math.round(off)}°`
}

/** 把一个方向向量说成人话：「朝 -X 偏 -Y 30°，向下 8°」 */
export function describeDirection(v: Vec3Like): string {
  const x = num(v.x)
  const y = num(v.y)
  const z = num(v.z)
  const len = Math.hypot(x, y, z)
  if (len < 1e-6) return '（零向量，没有方向）'
  const elevation = Math.asin(Math.max(-1, Math.min(1, z / len))) / DEG
  if (elevation > 87.5) return '几乎垂直向上'
  if (elevation < -87.5) return '几乎垂直向下'
  const heading = describeHeading({ x, y })
  if (Math.abs(elevation) < 2.5) return `朝 ${heading}，水平`
  return `朝 ${heading}，${elevation > 0 ? '向上' : '向下'} ${Math.round(Math.abs(elevation))}°`
}

export type OrientationKind = 'directional_light' | 'aimed' | 'generic'

/**
 * 按类名决定用哪套说法。
 * 沿 +X 发射/看出去的东西（灯、相机、SceneCapture）说「照向 / 看向」；
 * 其他 Actor 说「正面朝哪、顶面朝哪」—— 雾卡片、平面这类靠 roll 立起来的东西，
 * 「顶面朝 -Y（竖立着）」比三个角度直白得多。
 */
export function classifyOrientationKind(className?: string): OrientationKind {
  const c = (className ?? '').toLowerCase()
  if (c.includes('directionallight') || c.includes('sunlight')) return 'directional_light'
  if (
    c.includes('light') ||
    c.includes('camera') ||
    c.includes('scenecapture') ||
    c.includes('decal')
  ) {
    return 'aimed'
  }
  return 'generic'
}

export interface OrientationReport {
  /** 一句人话，直接拼进 message */
  text: string
  /** 值得单独提醒的事，空数组表示没什么可担心的 */
  warnings: string[]
  forward: Vec3
  up: Vec3
  /** 只有方向光才有 */
  sun?: { elevation: number; azimuth: number; below_horizon: boolean }
}

const sunBand = (elevation: number): string => {
  if (elevation < 2) return '贴着地平线，几乎没有直射光'
  if (elevation < 15) return '黄昏/黎明的低角度'
  if (elevation < 40) return '上午/下午的斜射'
  if (elevation < 70) return '接近正午'
  return '正午顶光'
}

const round3 = (v: Vec3): Vec3 => ({
  x: Math.round(v.x * 1000) / 1000,
  y: Math.round(v.y * 1000) / 1000,
  z: Math.round(v.z * 1000) / 1000
})

/**
 * 把一个旋转翻译成人话。className 决定说法，不给就按普通 Actor 说。
 */
export function describeOrientation(rot: RotatorLike, className?: string): OrientationReport {
  const axes = rotatorToAxes(rot)
  const kind = classifyOrientationKind(className)
  const warnings: string[] = []
  const pitch = num(rot.pitch)
  const roll = num(rot.roll)

  if (kind === 'directional_light') {
    const sun = rotatorToSun(rot)
    const below = sun.elevation <= 0
    let text: string
    if (below) {
      // 现象写在 text 里，这里只放原因和修法，真机上两句连着念会重复一遍
      warnings.push(
        `pitch=${round1(pitch)} 为正是仰照。要让太阳在天上，pitch 必须是负数：` +
          `黄昏 -5～-15，正午 -60～-90。或者直接给 sun: { elevation: 8, azimuth: … } 让工具算`
      )
      text = `方向光：⚠️ 太阳在地平线以下 ${Math.abs(sun.elevation)}°，光从地底往上照`
    } else {
      text =
        `方向光：太阳高度角 ${sun.elevation}°（${sunBand(sun.elevation)}），` +
        `太阳在 ${describeHeading({ x: -axes.forward.x, y: -axes.forward.y })}，` +
        `光往 ${describeHeading(axes.forward)} 照下来`
    }
    if (Math.abs(roll) > 0.5) {
      warnings.push(`roll=${round1(roll)} 对方向光没有意义（它只是一条方向），建议归零`)
    }
    return {
      text,
      warnings,
      forward: round3(axes.forward),
      up: round3(axes.up),
      sun: { elevation: sun.elevation, azimuth: sun.azimuth, below_horizon: below }
    }
  }

  if (kind === 'aimed') {
    return {
      text: `照向/看向 ${describeDirection(axes.forward).replace(/^朝 /, '')}`,
      warnings,
      forward: round3(axes.forward),
      up: round3(axes.up)
    }
  }

  const upZ = axes.up.z
  let upText: string
  if (upZ > 0.985) upText = '顶面(+Z)朝天（平放）'
  else if (upZ < -0.985) upText = '顶面(+Z)朝地（翻过来了）'
  else if (Math.abs(upZ) < 0.1) upText = `顶面(+Z)朝 ${describeHeading(axes.up)}（竖立着）`
  else upText = `顶面(+Z)${describeDirection(axes.up).replace(/^朝 /, '朝 ')}`
  return {
    text: `正面(+X)${describeDirection(axes.forward)}；${upText}`,
    warnings,
    forward: round3(axes.forward),
    up: round3(axes.up)
  }
}

/**
 * 这个 Actor 值不值得附一句朝向。
 * 灯和相机永远值得 —— 它们的旋转就是它们的全部。
 * 普通 Actor 只在 pitch/roll 非零时才说：只转了 yaw 的道具谁都看得懂，
 * 全场景几百个 Actor 每个都附一句就成了噪声。
 */
export function orientationWorthReporting(
  rot: RotatorLike | undefined,
  className?: string
): boolean {
  if (!rot) return false
  if (classifyOrientationKind(className) !== 'generic') return true
  return Math.abs(num(rot.pitch)) > 0.5 || Math.abs(num(rot.roll)) > 0.5
}

export interface OrientedActorLike {
  name?: string
  class?: string
  rotation?: RotatorLike
}

/**
 * 一批 Actor 的朝向摘要，拼在 message 尾部。
 * 最多说 limit 条，⚠️ 的优先 —— 一次批量改了 50 盏灯，先说错的那几盏。
 */
export function describeOrientations(actors: OrientedActorLike[], limit = 5): string {
  const reports = actors
    .filter((a) => orientationWorthReporting(a.rotation, a.class))
    .map((a) => ({ name: a.name ?? '(未命名)', report: describeOrientation(a.rotation!, a.class) }))
  if (reports.length === 0) return ''

  reports.sort(
    (a, b) => Number(b.report.warnings.length > 0) - Number(a.report.warnings.length > 0)
  )
  const shown = reports.slice(0, limit)
  const lines = shown.map(({ name, report }) => {
    const warn = report.warnings.length > 0 ? ` ⚠️ ${report.warnings.join('；')}` : ''
    return `${name}：${report.text}。${warn}`
  })
  const more =
    reports.length > shown.length ? `（还有 ${reports.length - shown.length} 个未列出）` : ''
  return `\n朝向：\n- ${lines.join('\n- ')}${more}`
}

/**
 * 相机专用：「镜头朝 +X 偏 -Y 20°，俯视 12°」。
 * 那次事故里参考机位被改成了仰视 33.6°，截图一片蓝天，模型以为场景没了。
 * 仰得厉害就直说画面多半是天空，让它别去怀疑场景。
 */
export function describeCameraAim(rot: RotatorLike | undefined): string {
  if (!rot) return ''
  const { forward } = rotatorToAxes(rot)
  const elevation = Math.asin(Math.max(-1, Math.min(1, forward.z))) / DEG
  const heading = describeHeading(forward)
  let tilt: string
  if (Math.abs(elevation) < 2.5) tilt = '平视'
  else if (elevation > 0) tilt = `仰视 ${Math.round(elevation)}°`
  else tilt = `俯视 ${Math.round(-elevation)}°`
  let note = ''
  if (elevation > 20) note = '（镜头抬得高，画面上半多半是天空；场景里的东西不在画里不代表不存在）'
  else if (elevation < -70) note = '（几乎垂直朝下，看到的是地面/顶视）'
  return `镜头朝 ${heading}，${tilt}${note}`
}

/**
 * 贴在工具描述里的旋转说明。措辞在几个工具之间保持一致。
 */
export const UE_ROTATION_NOTE = `【旋转约定】UE 的旋转是 (pitch, yaw, roll)，单位度。局部 +X 是「正面」，灯光和相机都沿 +X 照/看出去。
- pitch 绕 Y：**正值抬头、负值低头**。方向光要往下照，pitch 必须是负数：黄昏 -5～-15，正午 -60～-90。
- yaw 绕 Z：0 = 朝 +X，90 = 朝 +Y，180 = 朝 -X，-90 = 朝 -Y。
- roll 绕 X：正值右倾。方向光的 roll 没有意义，保持 0；平面/雾卡片用 roll=±90 立起来。
不想自己算正负号就别算：方向光给 sun: { elevation, azimuth }，其他东西给 face_direction: { x, y, z }（一个世界方向向量，比如「朝向相机」= 相机位置 - 自己位置），工具替你换成旋转。
改完看返回体里的「朝向」那一句，它是从引擎回读的旋转算出来的，和你填的没有关系。`
