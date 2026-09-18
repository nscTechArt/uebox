/**
 * UE 的长度单位是**厘米**。这个模块负责把这件事说出来，并让返回体自带量纲。
 *
 * ## 为什么值得单开一个模块
 *
 * 真机任务里翻过一次车：按参考图还原场景，23 个 Blender 资产、72 个 Actor，
 * 摆完全部堆在原点附近 —— 13 米高的建筑、26 米宽的云，以 0.2 米的间距挤成一团。
 * 根因很单薄：布局是按**米**算的（模型来自 Blender），而 UE 世界坐标是**厘米**，
 * `-19.5` 本意 19.5 米，填进去成了 19.5 厘米，整个场景缩小 100 倍。
 *
 * 值得记的不是「有人算错了一次」，而是**为什么连着好几轮自检都没发现**：
 *
 * - 位置类返回体是一串**裸数字**。`-19.5` 在米制下合理，在厘米制下同样合理 ——
 *   返回体里没有任何东西能把这两种读法分开。
 * - 于是自检只能做成「我填进去的和我读回来的一致吗」。一致，但同错。
 *   **自洽性校验对单位错误是结构性失明的**，再查几轮也查不出来。
 * - 网格接口回的是厘米（对的），Actor 位置回的是裸数字，两边摆在一起看不出冲突。
 *
 * 所以修法不是在提示词里多写一句「注意单位」，而是**让数据自己带上量纲**：
 * 位置一律附换算米值。100 倍的错在米值上一眼可见（间距 0.195 米 vs 19.5 米），
 * 在厘米裸值上不可见。
 *
 * 用在 `ue_spawn_actor` / `ue_set_transform` / `ue_get_actor` / `ue_mesh_summarize`。
 */

/** UE 世界单位：1 uu = 1 厘米 */
export const CM_PER_METER = 100

export interface Vec3Like {
  x?: number
  y?: number
  z?: number
}

/**
 * 贴在工具描述里的单位说明。措辞在几个工具之间保持一致 ——
 * 同一件事换三种说法，模型反而会以为是三件事。
 */
export const UE_UNIT_NOTE = `【单位是厘米，不是米】UE 世界坐标的单位是厘米：1 米 = 100，
一栋 13 米高的楼是 1300，两个物体隔 20 米是 2000。

从 Blender、参考图、平面图或任何按米思考的地方算出来的数，**填进来之前先 ×100**。
漏掉这一步不会报错：所有工具照常返回 success，只是整个场景缩小 100 倍堆在原点附近。

scale 是倍数不是长度，不参与换算。旋转是角度，也不参与。`

/** 给 schema 字段的 `.describe()` 用的短标注 */
export const CM_FIELD_NOTE = '单位厘米（1 米 = 100）'

const num = (value: number | undefined): number => (typeof value === 'number' ? value : 0)

/** 有意保留两位小数：米制下 100 倍的错差三个数量级，两位足够看出来 */
const meters = (value: number | undefined): string => (num(value) / CM_PER_METER).toFixed(2)

const centimeters = (value: number | undefined): string => String(Math.round(num(value) * 10) / 10)

/** 把一个厘米向量换算成米写出来 */
export function formatMeters(v: Vec3Like): string {
  return `${meters(v.x)} × ${meters(v.y)} × ${meters(v.z)} 米`
}

/** 把一个厘米向量写成「厘米 = 米」并排的形式 */
export function formatCmWithMeters(v: Vec3Like): string {
  return (
    `(${centimeters(v.x)}, ${centimeters(v.y)}, ${centimeters(v.z)}) 厘米` +
    ` = (${meters(v.x)}, ${meters(v.y)}, ${meters(v.z)}) 米`
  )
}

/** 把厘米向量换算成米，放进返回体供调用方自己判断，而不是只能读摘要 */
export function toMeters(v: Vec3Like): { x: number; y: number; z: number } {
  const round = (value: number | undefined): number =>
    Math.round((num(value) / CM_PER_METER) * 1000) / 1000
  return { x: round(v.x), y: round(v.y), z: round(v.z) }
}

/**
 * 把一批 Actor 的摆放尺度翻译成一句人话。
 *
 * 这一句是单位错误唯一能被**自动**看见的地方。72 个 Actor 摆完跨度只有 0.4 米，
 * 和跨度 40 米，在厘米裸坐标列表里长得差不多；写成米就是一眼的事。
 *
 * 一个 Actor 时报它自己的位置，多个时报整体跨度 —— 单点没有「跨度」可言，
 * 硬算出来一个 0 × 0 × 0 反而是噪声。
 */
export function describePlacementScale(locations: Vec3Like[]): string {
  const valid = locations.filter(
    (loc) =>
      loc && (typeof loc.x === 'number' || typeof loc.y === 'number' || typeof loc.z === 'number')
  )
  if (valid.length === 0) return ''

  if (valid.length === 1) {
    return ` 位置 ${formatCmWithMeters(valid[0])}。`
  }

  const span = (axis: 'x' | 'y' | 'z'): string => {
    const values = valid.map((loc) => num(loc[axis]))
    return meters(Math.max(...values) - Math.min(...values))
  }

  return (
    ` 这 ${valid.length} 个 Actor 的位置跨度：` +
    `X ${span('x')} 米 × Y ${span('y')} 米 × Z ${span('z')} 米` +
    `（UE 位置单位是厘米，这里已换算成米）。` +
    `跨度和你预期的场景尺寸差两个数量级时，先怀疑米/厘米，别急着挪物体。`
  )
}
