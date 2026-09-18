/**
 * 「这两个字符串指的是不是同一个 UE 工程」——**唯一**的那把尺子。
 *
 * ## 为什么值得一个单独的文件
 *
 * 这段逻辑此前在仓库里有六七份拷贝，而且它们**不一致**：一半削 `.uproject`，
 * 一半不削。糟糕的是这些拷贝分坐在同一个判断的两边 ——
 * `resolveSessionScope` 拿不削的那份问「归属工程连上了吗」，`retargetToProject`
 * 拿削的那份问「要切过去的是不是归属工程」。于是真机上出现过这一幕：
 * 会话戳记着 `I:/Dev/Pond/Pond.uproject`，插件报的是 `I:/Dev/Pond` ——
 * 切目标那边认为是同一个工程、切了过去并对用户说「已经改发给它」，
 * 而作用域那边认为没连上、一个 `ue.*` 工具都没注册。模型手里空空，
 * 嘴上却说已经接上了。
 *
 * 所以尺子只留一把，放在一个**不依赖任何服务**的文件里，谁都能 import ——
 * `core/sessionScope.ts` 是纯函数模块，不能为了比个路径就把 `projectManager`
 * 拖进它的依赖图。
 */

/**
 * 把工程路径抹成可比较的键。
 *
 * 三件事：大小写、斜杠方向、结尾斜杠。再加一件 —— 把 `.uproject` 削成它所在的
 * 目录：插件报上来的是工程目录，而模型和项目库给的往往是 `.uproject` 文件本身。
 *
 * 没有分隔符时**原样返回**，不要 `slice(0, -1)`：那会把
 * `'Pond.uproject'` 啃成 `'pond.uprojec'` —— 一个非空的垃圾键，过得了
 * 「空就拒绝」那道闸，然后和谁都比不上。裸文件名（模型直接把工程名当路径给）
 * 就会撞上这一条。
 */
export function projectPathKey(value: string | null | undefined): string {
  const raw = (value || '').trim().toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!raw.endsWith('.uproject')) return raw
  const cut = raw.lastIndexOf('/')
  return cut > 0 ? raw.slice(0, cut) : raw
}

/** 两个路径指的是不是同一个工程。空串谁都不等于 —— 「不知道」不是「相同」 */
export function isSameProjectPath(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  const key = projectPathKey(left)
  return key !== '' && key === projectPathKey(right)
}
