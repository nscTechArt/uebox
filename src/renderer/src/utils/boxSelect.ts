/**
 * 矩形框选引擎。
 *
 * 替代原先的 `dragselect`（GPL-3.0，无法在 MIT 项目里分发）。
 * 只实现 useFileSelection.ts 实际调用的那一小片 API 面（start:pre/start/update/end
 * 四个事件 + break/start/stop/setSettings/setSelection/clearSelection 六个方法），
 * 框选相关的所有业务逻辑（Shift 范围选择、Ctrl+A 双击、锚点等）都留在调用方，
 * 这里只做"框选出的矩形和哪些元素相交"这一件事。
 *
 * 行为上刻意贴近原库：mousedown 在 area 上后框即随鼠标增长（不设启动阈值），
 * 是否算"点击"还是"拖拽"由调用方自己的距离/时间判断决定，这里不重复引入第二套阈值。
 */

export interface BoxSelectOptions {
  /** 框选发生的容器，也是自动滚动的对象 */
  area: HTMLElement
  /** 候选可选中元素 */
  selectables: HTMLElement[]
  /** 相交比例阈值（0~1）。0 表示只要碰到边缘就算命中，与原库 selectionThreshold:0 语义一致 */
  selectionThreshold?: number
  /** 每帧自动滚动的像素数 */
  autoScrollSpeed?: number
  /** 鼠标距容器边缘多近开始自动滚动 */
  overflowTolerance?: { x: number; y: number }
}

type BoxSelectEventName = 'start:pre' | 'start' | 'update' | 'end'
type BoxSelectListener = (payload: { event?: MouseEvent; items?: HTMLElement[] }) => void

export class BoxSelect {
  private area: HTMLElement
  private selectables: HTMLElement[]
  private selectionThreshold: number
  private autoScrollSpeed: number
  private overflowTolerance: { x: number; y: number }

  private listeners = new Map<BoxSelectEventName, Set<BoxSelectListener>>()
  private running = false
  private broken = false

  private originX = 0
  private originY = 0
  private originScrollTop = 0
  // 仅在本次拖动内记住经过的卡片位置，DOM 回收后仍按当前选框重新判定。
  private dragRects = new Map<
    string | HTMLElement,
    {
      element: HTMLElement
      left: number
      right: number
      top: number
      bottom: number
    }
  >()
  private lastEvent: MouseEvent | null = null
  private boxEl: HTMLDivElement | null = null
  private scrollRafId: number | null = null

  private onMouseDown = (event: MouseEvent): void => {
    // 只处理左键；且必须真的落在 area（或其子元素）上
    if (event.button !== 0) return

    this.broken = false
    this.emit('start:pre', { event })
    if (this.broken) return

    this.originX = event.clientX
    this.originY = event.clientY
    this.originScrollTop = this.area.scrollTop
    this.dragRects.clear()
    this.rememberRects()
    this.running = true
    this.emit('start', { event })

    document.addEventListener('mousemove', this.onMouseMove)
    document.addEventListener('mouseup', this.onMouseUp)
  }

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.running) return
    this.lastEvent = event
    this.updateBoxVisual(event)
    this.emit('update', { items: this.hitTest(event) })
    this.maybeAutoScroll(event)
  }

  private onMouseUp = (event: MouseEvent): void => {
    document.removeEventListener('mousemove', this.onMouseMove)
    document.removeEventListener('mouseup', this.onMouseUp)
    this.stopAutoScroll()
    this.removeBoxVisual()

    const items = this.running ? this.hitTest(event) : []
    this.running = false
    this.emit('end', { items })
    this.dragRects.clear()
  }

  constructor(options: BoxSelectOptions) {
    this.area = options.area
    this.selectables = options.selectables
    this.selectionThreshold = options.selectionThreshold ?? 0
    this.autoScrollSpeed = options.autoScrollSpeed ?? 0
    this.overflowTolerance = options.overflowTolerance ?? { x: 0, y: 0 }

    this.area.addEventListener('mousedown', this.onMouseDown)
  }

  /** 当前是否正处于一次框选拖拽中（供调用方诊断日志读取） */
  get isDragging(): boolean {
    return this.running
  }

  subscribe(name: BoxSelectEventName, cb: BoxSelectListener): void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set())
    this.listeners.get(name)!.add(cb)
  }

  private emit(
    name: BoxSelectEventName,
    payload: { event?: MouseEvent; items?: HTMLElement[] }
  ): void {
    this.listeners.get(name)?.forEach((cb) => cb(payload))
  }

  /** 在 start:pre 回调里调用，取消本次即将开始的框选（不销毁实例） */
  break(): void {
    this.broken = true
  }

  start(): void {
    this.area.addEventListener('mousedown', this.onMouseDown)
  }

  /**
   * @param _remove 未使用，保留形参是为了跟原 dragselect.stop() 签名对齐，调用方不用改
   * @param _fromSelection 未使用，同上
   * @param withCallback 为 true 时即便当前没有在拖拽也照常触发一次 end（items 为空），
   *   用于外部强制中断框选但仍需下游状态复位的场景（如 pauseDragSelect）
   */
  stop(_remove = false, _fromSelection = false, withCallback = false): void {
    this.area.removeEventListener('mousedown', this.onMouseDown)
    document.removeEventListener('mousemove', this.onMouseMove)
    document.removeEventListener('mouseup', this.onMouseUp)
    this.stopAutoScroll()
    this.removeBoxVisual()

    const wasRunning = this.running
    this.running = false

    if (withCallback && wasRunning) {
      this.emit('end', { items: [] })
    }
    this.dragRects.clear()
  }

  setSettings(options: Partial<BoxSelectOptions>): void {
    if (options.selectables) this.selectables = options.selectables
    if (options.selectionThreshold !== undefined)
      this.selectionThreshold = options.selectionThreshold
    if (options.autoScrollSpeed !== undefined) this.autoScrollSpeed = options.autoScrollSpeed
    if (options.overflowTolerance) this.overflowTolerance = options.overflowTolerance
  }

  /**
   * 供外部把 Vue 侧的选择状态同步进来（保留 API 兼容，实际本引擎不维护自己的选中态，
   * 选中态完全交给调用方的 selectedFiles 响应式数据 + 模板 :class 绑定）
   */
  setSelection(_elements: HTMLElement[]): void {
    // no-op：视觉高亮已由调用方模板的 isSelected() + :class 驱动，这里无需重复处理
  }

  clearSelection(): void {
    // no-op，理由同上
  }

  private rememberRects(): void {
    for (const element of this.selectables) {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      this.dragRects.set(element.dataset.fileId || element, {
        element,
        left: rect.left,
        right: rect.right,
        top: rect.top + this.area.scrollTop,
        bottom: rect.bottom + this.area.scrollTop
      })
    }
  }

  private hitTest(event: MouseEvent): HTMLElement[] {
    this.rememberRects()
    const left = Math.min(this.originX, event.clientX)
    const right = Math.max(this.originX, event.clientX)
    const originY = this.originY + this.originScrollTop
    const pointerY = event.clientY + this.area.scrollTop
    const top = Math.min(originY, pointerY)
    const bottom = Math.max(originY, pointerY)

    const hits: HTMLElement[] = []
    for (const rect of this.dragRects.values()) {
      const overlapX = Math.max(0, Math.min(right, rect.right) - Math.max(left, rect.left))
      const overlapY = Math.max(0, Math.min(bottom, rect.bottom) - Math.max(top, rect.top))
      const overlapArea = overlapX * overlapY

      if (this.selectionThreshold <= 0) {
        if (overlapArea > 0) hits.push(rect.element)
      } else {
        const elArea = (rect.right - rect.left) * (rect.bottom - rect.top)
        if (elArea > 0 && overlapArea / elArea >= this.selectionThreshold) hits.push(rect.element)
      }
    }
    return hits
  }

  private updateBoxVisual(event: MouseEvent): void {
    if (!this.boxEl) {
      this.boxEl = document.createElement('div')
      this.boxEl.className = 'box-select-rect'
      Object.assign(this.boxEl.style, {
        position: 'fixed',
        border: '1px solid var(--color-border)',
        background: 'rgba(76, 141, 255, 0.12)',
        pointerEvents: 'none',
        zIndex: '9999'
      } as CSSStyleDeclaration)
      document.body.appendChild(this.boxEl)
    }

    const left = Math.min(this.originX, event.clientX)
    const originY = this.originY - (this.area.scrollTop - this.originScrollTop)
    const top = Math.min(originY, event.clientY)
    const width = Math.abs(event.clientX - this.originX)
    const height = Math.abs(event.clientY - originY)

    this.boxEl.style.left = `${left}px`
    this.boxEl.style.top = `${top}px`
    this.boxEl.style.width = `${width}px`
    this.boxEl.style.height = `${height}px`
  }

  private removeBoxVisual(): void {
    this.boxEl?.remove()
    this.boxEl = null
  }

  private maybeAutoScroll(event: MouseEvent): void {
    if (this.autoScrollSpeed <= 0) {
      this.stopAutoScroll()
      return
    }

    const rect = this.area.getBoundingClientRect()
    let dy = 0
    if (event.clientY < rect.top + this.overflowTolerance.y) {
      dy = -this.autoScrollSpeed
    } else if (event.clientY > rect.bottom - this.overflowTolerance.y) {
      dy = this.autoScrollSpeed
    }

    if (dy === 0) {
      this.stopAutoScroll()
      return
    }

    if (this.scrollRafId !== null) return // 已有滚动循环在跑

    const tick = (): void => {
      if (!this.running) {
        this.scrollRafId = null
        return
      }
      this.area.scrollTop += dy
      // 滚动会改变元素相对视口的位置，用最近一次鼠标事件重新算一次相交
      if (this.lastEvent) this.emit('update', { items: this.hitTest(this.lastEvent) })
      this.scrollRafId = requestAnimationFrame(tick)
    }
    this.scrollRafId = requestAnimationFrame(tick)
  }

  private stopAutoScroll(): void {
    if (this.scrollRafId !== null) {
      cancelAnimationFrame(this.scrollRafId)
      this.scrollRafId = null
    }
  }
}

export default BoxSelect
