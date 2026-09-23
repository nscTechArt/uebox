/**
 * 拖拽时指针是不是还在元素里面。
 *
 * `dragleave` 不只在真离开时触发：指针从输入框的一个子元素（文本框、按钮）划到另一个，
 * 子元素上的 `dragleave` 也会冒泡上来。照单全收的话，高亮随着鼠标移动一关一开，整框闪个不停。
 * 所以按坐标认：还在框内的那些不算离开。边界上算离开；按 Esc 取消时坐标是 (0, 0)，也落在框外
 */
export function pointerStillInside(
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>,
  x: number,
  y: number
): boolean {
  return x > rect.left && x < rect.right && y > rect.top && y < rect.bottom
}
