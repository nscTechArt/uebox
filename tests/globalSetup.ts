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
 * 预热失败不拦门禁：没装上 sharp 的话，真正用到它的测试自己会红，报错更准。
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
}
