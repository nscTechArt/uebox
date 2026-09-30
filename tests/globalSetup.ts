import { createRequire } from 'node:module'

/**
 * 全量测试开跑前、worker 起来之前，在主进程里做一次的事。
 *
 * ## 预热 sharp 的文字渲染
 *
 * 拼图（`contactSheet.ts`）往格子上烧「序号 · 秒数」，走的是 SVG 文字 ——
 * sharp 第一次画字时要让 fontconfig 扫一遍系统字体、建字体缓存。本机早就有
 * 缓存，几十毫秒；CI 的 Windows 机器每次都是干净的，4 个 worker 同时冷启动、
 * 同时去扫同一个字体目录，谁先画字谁吃掉十来秒，正好撞上 10 秒的单测超时。
 * 表现是 `playtest.test.ts` 的「多帧采样」随机红，单独重跑又是绿的。
 *
 * 在这里先画一次，缓存落盘，后面每个 worker 直接读现成的。
 *
 * ## 预热 better-sqlite3 的原生产物
 *
 * CI 上 `test:run` 先跑 `better-sqlite3-abi.mjs ensure node`，现解压出一份从没被
 * 加载过的 `better_sqlite3.node`，紧接着 4 个 worker 各自第一次 `new Database()`
 * 时才去加载它。干净机器上第一次加载一个新 DLL 要过一遍杀毒扫描，和别的 worker
 * 的磁盘活挤在一起时能卡几十秒 —— 而这一下落在哪个测试里，就是哪个测试超时。
 * 实际撞上的是 `SyncClient.oldVaultUpgrade.test.ts` 的第一条：同步测试，整个
 * 文件跑了 43 秒，同一时刻别的 worker 照常一秒几个文件，唯一一次性的开销就是它。
 *
 * 在这里经测试垫片（和测试里拿到的是同一个文件）先开一个内存库，扫描在 worker
 * 起来之前做完，后面每个 worker 加载的是已经扫过的文件。
 *
 * 两项预热失败都不拦门禁：没装上的话，真正用到它的测试自己会红，报错更准。
 */
export default async function setup(): Promise<void> {
  try {
    const sharp = (await import('sharp')).default
    await sharp(
      Buffer.from(
        '<svg width="64" height="24" xmlns="http://www.w3.org/2000/svg">' +
          '<text x="2" y="18" font-family="sans-serif" font-size="14">1 · 0.5s</text></svg>'
      )
    )
      .png()
      .toBuffer()
  } catch {
    // 见上
  }

  try {
    const Database = createRequire(import.meta.url)('./support/betterSqlite3.node-abi.cjs')
    new Database(':memory:').close()
  } catch {
    // 见上
  }
}
