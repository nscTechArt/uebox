import { onBeforeUnmount, ref, Ref } from 'vue'

/**
 * 自定义中键自动滚动 Hook
 * 专为 transform: scaleY(-1) 翻转容器设计
 * 修复了浏览器原生中键滚动在翻转容器中方向相反的问题
 *
 * @param scrollerRef 滚动容器的 Ref
 * @returns { handleMouseDown } 绑定到容器的 mousedown 事件处理函数
 */
export function useAutoScroll(scrollerRef: Ref<HTMLElement | null>) {
  // 滚动状态
  const isScrolling = ref(false)
  // 起始点 Y 坐标
  const startY = ref(0)
  // 当前鼠标 Y 坐标
  const currentY = ref(0)
  // 动画帧 ID
  let animationFrameId: number | null = null
  // 滚动锚点元素（模拟原生 UI）
  let anchorEl: HTMLElement | null = null
  // 动态注入的样式元素（用于强制光标覆盖）
  let styleEl: HTMLStyleElement | null = null
  // 当前光标值缓存（避免重复更新样式导致卡顿）
  let currentCursor: string = ''

  /**
   * 创建强制光标样式
   * 使用 !important 覆盖所有元素的光标样式
   * 优化：只在光标值变化时才更新样式，避免频繁 DOM 操作
   */
  const createCursorStyle = (cursor: string): void => {
    // 如果光标值没变，跳过更新
    if (currentCursor === cursor && styleEl) return
    currentCursor = cursor

    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.id = 'auto-scroll-cursor-override'
      document.head.appendChild(styleEl)
    }
    styleEl.textContent = `*, *::before, *::after { cursor: ${cursor} !important; }`
  }

  /**
   * 移除强制光标样式
   */
  const removeCursorStyle = (): void => {
    if (styleEl) {
      document.head.removeChild(styleEl)
      styleEl = null
    }
    // 重置光标缓存
    currentCursor = ''
  }

  // 定义 SVG 图标字符串
  const UP_ICON = `<svg t="1768411614620" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="33626" width="16" height="16"><path d="M512 746.666667m-128 0a128 128 0 1 0 256 0 128 128 0 1 0-256 0Z" p-id="33627" fill="currentColor"></path><path d="M719.274667 344.405333L527.189333 155.306667a19.754667 19.754667 0 0 0-28.330666 0l-194.133334 191.061333a18.986667 18.986667 0 0 0 0 27.861333c4.053333 3.968 8.106667 5.973333 14.165334 5.973334h95.018666v133.205333c0 9.941333 10.112 19.882667 20.224 19.882667h155.690667a20.138667 20.138667 0 0 0 20.224-19.882667V378.24h95.061333A20.096 20.096 0 0 0 725.333333 358.357333a17.962667 17.962667 0 0 0-6.058666-13.952z" p-id="33628" fill="currentColor"></path></svg>`

  const DOWN_ICON = `<svg t="1768411590622" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="32371" width="16" height="16"><path d="M512 277.333333m-128 0a128 128 0 1 0 256 0 128 128 0 1 0-256 0Z" p-id="32372" fill="currentColor"></path><path d="M705.109333 645.802667h-95.061333v-135.210667a20.053333 20.053333 0 0 0-20.224-19.882667h-155.690667c-10.112 0-20.224 9.941333-20.224 19.882667v133.205333H318.890667a18.602667 18.602667 0 0 0-14.165334 5.973334 18.986667 18.986667 0 0 0 0 27.861333l194.133334 191.061333c8.106667 7.978667 20.224 7.978667 28.330666 0l192.085334-189.098666a17.834667 17.834667 0 0 0 6.058666-13.909334 20.096 20.096 0 0 0-20.224-19.882666z" p-id="32373" fill="currentColor"></path></svg>`

  const MIDDLE_ICON = `<svg t="1768411306485" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="23298" width="16" height="16">
    <!-- 主题前景色圆形边框 -->
    <circle cx="512" cy="512" r="480" fill="none" stroke="currentColor" stroke-width="50"/>
    <!-- 中间主题前景色实心圆点 -->
    <circle cx="512" cy="512" r="100" fill="currentColor"/>
    <!-- 上箭头 -->
    <g transform="translate(512, 340) scale(0.45) translate(-512, -436)">
      <path d="M112.528645 436.205825l802.441232 0c6.997042 0 13.396775-4.309154 16.127328-10.836882 2.645223-6.570393 1.194617-14.036748-3.797175-19.02854l-401.177951-401.220616c-6.826382-6.826382-17.876588-6.826382-24.702971 0L100.155827 406.340402C95.164035 411.332194 93.670764 418.841215 96.401317 425.411608 99.089205 431.896671 105.446273 436.205825 112.528645 436.205825z" p-id="23299" fill="currentColor"/>
    </g>
    <!-- 下箭头 -->
    <g transform="translate(512, 684) scale(0.45) translate(-512, -581)">
      <path d="M914.969876 581.394442 112.528645 581.394442c-7.039707 0-13.396775 4.309154-16.127328 10.794217-2.730553 6.485063-1.237282 13.994084 3.75451 18.985876l401.263281 401.135286c6.826382 6.826382 17.876588 6.826382 24.702971 0l401.177951-401.135286c4.991792-4.991792 6.399733-12.500812 3.797175-18.985876C928.409316 585.703596 921.966918 581.394442 914.969876 581.394442z" p-id="23300" fill="currentColor"/>
    </g>
  </svg>`

  // 辅助函数：将 SVG 转为 Data URI
  // 热点位置设为中心 (8, 8)，使光标图标居中显示
  const svgToDataUri = (svg: string, color: string): string => {
    const themedSvg = svg.replace(/currentColor/g, color)
    return `url('data:image/svg+xml;utf8,${encodeURIComponent(themedSvg)}') 8 8, auto`
  }

  const resolveIconColor = (): string => {
    const colorSource = anchorEl ?? scrollerRef.value ?? document.documentElement
    return getComputedStyle(colorSource).color.trim() || 'CanvasText'
  }

  /**
   * 创建并显示滚动锚点图标
   */
  const createAnchor = (x: number, y: number) => {
    if (anchorEl) return

    anchorEl = document.createElement('div')
    anchorEl.className = 'auto-scroll-anchor'
    anchorEl.style.position = 'fixed'
    anchorEl.style.left = `${x - 16}px` // 32/2 = 16
    anchorEl.style.top = `${y - 16}px`
    anchorEl.style.width = '32px'
    anchorEl.style.height = '32px'
    anchorEl.style.color = 'var(--color-text-primary)'
    // 圆形边框和箭头由 SVG 自身绘制
    anchorEl.style.backgroundColor = 'transparent'
    anchorEl.style.border = 'none'
    anchorEl.style.boxShadow = 'none'
    anchorEl.style.borderRadius = '0'
    anchorEl.style.zIndex = '9999'
    anchorEl.style.pointerEvents = 'none'
    anchorEl.style.display = 'flex'
    anchorEl.style.alignItems = 'center'
    anchorEl.style.justifyContent = 'center'

    // 内部图标使用 MIDDLE_ICON
    anchorEl.innerHTML = MIDDLE_ICON

    document.body.appendChild(anchorEl)
    // 初始光标设为 none，因为锚点已经在那里了，避免重叠
    // 使用强制样式覆盖所有元素的光标
    createCursorStyle('none')
  }

  /**
   * 移除滚动锚点图标
   */
  const removeAnchor = () => {
    if (anchorEl) {
      document.body.removeChild(anchorEl)
      anchorEl = null
    }
    // 移除强制光标样式，恢复正常
    removeCursorStyle()
  }

  /**
   * 滚动动画循环
   */
  const scrollLoop = () => {
    if (!isScrolling.value || !scrollerRef.value) return

    const deltaY = currentY.value - startY.value
    // 阈值：鼠标移动超过 10px 才开始滚动
    if (Math.abs(deltaY) > 10) {
      // 速度系数
      const speed = deltaY * Math.abs(deltaY) * 0.002
      scrollerRef.value.scrollTop -= speed
    }

    animationFrameId = requestAnimationFrame(scrollLoop)
  }

  /**
   * 全局鼠标移动事件处理
   */
  const handleMouseMove = (e: MouseEvent) => {
    currentY.value = e.clientY

    // 锚点跟随鼠标移动：X 轴自由移动，Y 轴限制在起始点 ±10 像素范围内
    if (anchorEl) {
      anchorEl.style.left = `${e.clientX - 16}px`
      // Y 轴限制在 startY ±10 像素范围内
      const yOffset = Math.max(-10, Math.min(10, e.clientY - startY.value))
      anchorEl.style.top = `${startY.value + yOffset - 16}px`
    }

    const diff = e.clientY - startY.value
    // 动态调整光标方向提示
    if (Math.abs(diff) > 10) {
      // 滚动状态：透明度降低，显示自定义光标
      if (anchorEl) anchorEl.style.opacity = '0'
      // 根据方向选择光标，使用强制样式覆盖
      const iconColor = resolveIconColor()
      createCursorStyle(
        diff > 0 ? svgToDataUri(DOWN_ICON, iconColor) : svgToDataUri(UP_ICON, iconColor)
      )
    } else {
      // 归位状态（死区）：不透明，隐藏光标
      if (anchorEl) anchorEl.style.opacity = '1'
      createCursorStyle('none')
    }
  }

  /**
   * 退出自动滚动模式
   */
  const stopAutoScroll = () => {
    isScrolling.value = false
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
    removeAnchor()
    window.removeEventListener('mousemove', handleMouseMove)
    window.removeEventListener('mouseup', stopAutoScroll)
    window.removeEventListener('mousedown', stopAutoScroll) // 任意键点击退出
    window.removeEventListener('keydown', stopAutoScroll) // 按键退出
  }

  /**
   * 容器鼠标按下事件处理
   * 绑定到 @mousedown
   */
  const handleMouseDown = (e: MouseEvent) => {
    // 仅响应中键点击 (button === 1)
    if (e.button !== 1) return

    // 阻止原生自动滚动行为
    e.preventDefault()
    // 阻止事件冒泡，防止立即触发 window 上的 stopAutoScroll
    e.stopPropagation()

    // 如果已经在滚动中，再次点击中键则退出
    if (isScrolling.value) {
      stopAutoScroll()
      return
    }

    // 初始化状态
    isScrolling.value = true
    startY.value = e.clientY
    currentY.value = e.clientY

    // 显示 UI
    createAnchor(e.clientX, e.clientY)

    // 绑定全局事件
    window.addEventListener('mousemove', handleMouseMove)
    // 注意：这里不绑定 mouseup 退出，因为原生中键滚动有两种模式：
    // 1. 点击中键释放 -> 进入自动滚动模式 -> 再次点击退出（我们实现这个）
    // 2. 按住中键拖动 -> 滚动 -> 松开退出（暂不实现复杂的拖拽模式，统一用点击模式体验更好控制）
    // 为了体验一致性，我们采用“点击触发，任意点击退出”的逻辑
    window.addEventListener('mousedown', stopAutoScroll)
    window.addEventListener('keydown', stopAutoScroll)
    window.addEventListener('blur', stopAutoScroll) // 窗口失焦退出

    // 启动动画循环
    scrollLoop()
  }

  // 组件卸载时清理
  onBeforeUnmount(() => {
    stopAutoScroll()
  })

  return {
    handleMouseDown
  }
}
