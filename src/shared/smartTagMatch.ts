/**
 * 智能标签的命中判据。主进程（导入时落库）和渲染层（资产详情面板实时算）共用这一份 ——
 * 原来两边各写一份，修了主进程那份，详情面板照旧把 `SM_Door_01` 标成 Diffuse + Material。
 *
 * 规则表里每条 pattern 都只有两种形状：
 *
 * - **前缀族**（`BP_` / `SM_` / `T_`，以 `_` 结尾）—— UE 约定里它在**名字开头**，只认 `startsWith`。
 *   这样 `SM_DOOR` 不再命中 `M_`、`S_`。
 * - **后缀族**（`_D` / `_NORMAL` / `_ORM`，以 `_` 开头）—— 它是**通道位**，在名字末尾或末尾数字
 *   之前（`T_Rock_D` / `T_Rock_D_01`）。后面必须是结尾或另一个 `_`，`_D` 才不会去撞 `_DOOR`。
 *
 * 原来还有一条「任意位置的裸子串」，它让上面两条全部失效：`SM_` 里的 `M_` 让每个 StaticMesh
 * 都带 Material，`_R` 撞 `_ROCK` 打出 Roughness。
 */

/** 资产名规整成比对用的键：摘掉扩展名（`T_Rock_D.png` 的通道位才认得出）、转大写 */
export function smartTagNameKey(assetName: string): string {
  return assetName.replace(/\.[A-Za-z0-9]{2,5}$/, '').toUpperCase()
}

/** 一条 pattern（已转大写）在规整过的名字上命中没有 */
export function smartTagPatternHits(nameUpper: string, patternUpper: string): boolean {
  // 前缀族：`BP_` `SM_` `MI_` …
  if (patternUpper.endsWith('_')) return nameUpper.startsWith(patternUpper)

  // 后缀族：`_D` `_NORMAL` `_ORM` …。补一个 `_` 把「到头了」和「下一段是新的 `_` 分节」合成一种
  if (patternUpper.startsWith('_')) return `${nameUpper}_`.includes(`${patternUpper}_`)

  // 规则表里目前没有第三种形状。真加了也不该悄悄放宽成裸子串
  return nameUpper === patternUpper
}
