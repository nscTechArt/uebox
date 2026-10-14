/**
 * 像素图放大多少倍才是整数个屏幕像素。
 *
 * 屏幕缩放 125%、150% 时，CSS 里放大 2 倍落到屏幕上是 2.5 个像素 —— 有的格子 2 个、
 * 有的 3 个，方块就不方了。这里把「每格几个屏幕像素」取整，再换回 CSS 像素。
 */
export function cssPerPixel(scale: number): number {
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  return Math.max(1, Math.round(scale * dpr)) / dpr
}
