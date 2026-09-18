import { computed, ref, onMounted, onUnmounted, nextTick, type Ref } from 'vue'
import { BoxSelect } from '@renderer/utils/boxSelect'

export interface FileItem {
  id: string
  name: string
  type: 'file' | 'folder'
  [key: string]: any
}

interface FileSelection {
  selectedFiles: Ref<Set<string>>
  containerRef: Ref<HTMLElement | null>
  initDragSelect: (container: HTMLElement) => Promise<void>
  updateSelectables: () => Promise<void>
  setSelected: (ids: string | string[], selected?: boolean) => void
  toggleSelected: (id: string) => void
  clearSelection: () => void
  selectAll: (ids: string[]) => void
  selectOnlyFiles: () => void
  selectOnlyFolders: () => void
  selectFilesAndFolders: () => void
  isSelected: (id: string) => boolean
  getSelectedCount: () => number
  getSelectedIds: () => string[]
  handleItemClick: (id: string, event: MouseEvent) => void
  handleMouseDown: (event: MouseEvent) => void
  handleMouseUp: (event: MouseEvent) => void
  setDeleteCallback: (callback: (ids: string[]) => void) => void
  setFavoriteToggleCallback: (callback: (ids: string[]) => void) => void
  setInlineRenameCallback: (callback: (id: string) => void) => void
  setLocateInFolderCallback: (callback: () => void) => void
  destroyDragSelect: () => void
  isMouseOnSelectedFile: Ref<boolean>
  getIsMouseOnSelectedFile: (target?: HTMLElement | EventTarget | null) => boolean
  pauseDragSelect: () => void
  resumeDragSelect: () => Promise<void>
}

export function useFileSelection(
  options: {
    getItems?: () => Array<{ id: string; type: 'file' | 'folder' }>
    loadAll?: () => Promise<boolean>
  } = {}
): FileSelection {
  const selectedFiles = ref<Set<string>>(new Set())
  const dragSelectInstance = ref<BoxSelect | null>(null)
  const containerRef = ref<HTMLElement | null>(null)
  let selectionVersion = 0
  let selectingAll = false
  const getItems = (): Array<{ id: string; type: 'file' | 'folder' }> =>
    options.getItems?.() ??
    Array.from(containerRef.value?.querySelectorAll<HTMLElement>('.file-item') ?? [])
      .map((el) => ({
        id: el.dataset.fileId || '',
        type: el.classList.contains('folder-item') ? ('folder' as const) : ('file' as const)
      }))
      .filter((item) => item.id)

  const validIds = computed(() =>
    options.getItems ? new Set(getItems().map((item) => item.id)) : null
  )
  const applyBoxSelection = (items: HTMLElement[]): void => {
    const ids: string[] = []
    for (const item of items) if (item.dataset.fileId) ids.push(item.dataset.fileId)
    const candidates = dragStartModifiers.value.shiftKey
      ? [...preSelectionSnapshot.value, ...ids]
      : ids
    selectedFiles.value = new Set(
      candidates.filter((id) => !validIds.value || validIds.value.has(id))
    )
  }

  /**
   * 锚点：用于 Shift 范围选择的起始点
   * Windows 标准行为：普通点击和 Ctrl+点击都会更新锚点
   */
  const anchorFileId = ref<string | null>(null)

  /**
   * 最近一次 Ctrl+A 的时间戳，用于实现 500ms 双击选择逻辑
   */
  const lastCtrlATime = ref<number>(0)

  /**
   * 收藏切换回调（由外部组件设置），用于 Ctrl + D 快捷键
   */
  let onToggleFavoriteSelected: ((fileIds: string[]) => void) | undefined

  /**
   * 行内重命名回调（由外部组件设置），用于 F2 快捷键
   */
  let onInlineRename: ((fileId: string) => void) | undefined

  // RAF ID for throttling updates
  let rafId: number | null = null

  // 初始化DragSelect
  const initDragSelect = async (container: HTMLElement) => {
    await nextTick()

    if (dragSelectInstance.value) {
      dragSelectInstance.value.stop()
    }

    dragSelectInstance.value = new BoxSelect({
      selectables: Array.from(container.querySelectorAll('.file-item')) as HTMLElement[],
      area: container,
      selectionThreshold: 0, // 设置为0，只要触碰到就选中，提高选择的可靠性
      autoScrollSpeed: 5, // 启用自动滚动
      overflowTolerance: { x: 25, y: 25 } // 增加溢出容忍度
    })

    // 在开始框选前拦截：如果鼠标在已选中元素上，则认定为拖拽，停止 DragSelect
    dragSelectInstance.value!.subscribe('start:pre', (_payload: any) => {
      const isOnSelected = getIsMouseOnSelectedFile()
      const isOnFileItem = getIsMouseOnFileItem()
      const selectedCount = selectedFiles.value.size

      console.log('[DragSelect] DS:start:pre 触发', {
        isOnSelected,
        isOnFileItem,
        selectedCount,
        isDragSelecting: isDragSelecting.value,
        isMouseOnSelectedFile: isMouseOnSelectedFile.value,
        mouseDownInfo: mouseDownInfo.value
          ? {
              isOnFileItem: mouseDownInfo.value.isOnFileItem,
              target: mouseDownInfo.value.target?.className
            }
          : null,
        lastMousePos: lastMousePos.value
      })

      if (isOnSelected) {
        // 阻止 DragSelect 的框选启动，不中断实例，仅打断本次流程
        console.log('[DragSelect] DS:start:pre 拦截：鼠标在已选中元素上，break')
        dragSelectInstance.value!.break()
        return
      }

      // 当当前没有选择的数据且鼠标在某个文件项上，也需要打断框选
      if (selectedCount === 0 && isOnFileItem) {
        console.log('[DragSelect] DS:start:pre 拦截：无选中但在文件项上，break')
        dragSelectInstance.value!.break()
        return
      }

      console.log('[DragSelect] DS:start:pre 通过：允许框选启动')
    })

    // 监听选择事件
    dragSelectInstance.value!.subscribe('end', (payload: any) => {
      const { items } = payload
      if (rafId !== null) cancelAnimationFrame(rafId)
      rafId = null
      applyBoxSelection(items)

      // 框选结束，重置拖拽状态
      isDragSelecting.value = false
    })

    // 监听开始选择事件
    dragSelectInstance.value!.subscribe('start', (payload: any) => {
      selectionVersion++
      const { event } = payload
      // 记录框选开始时的修饰键状态
      dragStartModifiers.value = {
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey
      }

      // 如果按住Shift键，保存当前选择作为快照，用于累加选择
      if (event.shiftKey) {
        preSelectionSnapshot.value = new Set(selectedFiles.value)
      } else {
        // 非Shift键：若鼠标不在已选元素上，清空旧选择，开始新的框选
        // 移除 setTimeout 以避免与 DS:update 的 RAF 发生竞态，导致旧选择在 clear 后被 RAF 重新应用
        if (!getIsMouseOnSelectedFile(event?.target as HTMLElement)) {
          clearSelection()
        }
      }
    })

    // 使用 requestAnimationFrame 节流更新，避免高频触发 Vue 响应式更新导致卡顿

    // 监听拖拽过程中的选择更新
    dragSelectInstance.value!.subscribe('update', (payload: any) => {
      // 如果已有挂起的更新，直接返回，等待下一帧处理最新数据（DS会持续触发update，我们只取最新的一次）
      // 注意：这里其实可以不存储 items，因为 RAF 回调执行时我们只关心当前的 payload
      // 但由于 RAF 是异步的，为了闭包能访问到最新的 payload，我们需要确保逻辑正确
      // 这里 dragselect 的实现是同步触发 callback，所以直接用闭包变量即可？
      // 不，RAF 回调执行时 payload 可能已经旧了？
      // 实际上只要在 RAF 执行时重新获取数据最好，但 payload 是传进来的。
      //更稳妥的方式：保存最新的 items 到外部变量，RAF 只负责读取该变量

      const { items } = payload

      if (rafId !== null) {
        cancelAnimationFrame(rafId)
      }

      rafId = requestAnimationFrame(() => {
        // 只有在真正有拖拽行为时才设置拖拽状态
        if (!isDragSelecting.value) {
          isDragSelecting.value = true
        }

        applyBoxSelection(items)

        rafId = null
      })
    })
  }

  // 更新可选择的元素
  const updateSelectables = async (): Promise<void> => {
    await nextTick()
    if (!dragSelectInstance.value || !containerRef.value) return
    // 更新候选项即可，不能打断正在进行的跨屏框选。
    dragSelectInstance.value.setSettings({
      selectables: Array.from(containerRef.value.querySelectorAll<HTMLElement>('.file-item'))
    })
  }

  // 设置选中状态
  const setSelected = (fileIds: string | string[], selected = true) => {
    selectionVersion++
    const ids = Array.isArray(fileIds) ? fileIds : [fileIds]

    if (selected) {
      ids.forEach((id) => selectedFiles.value.add(id))
    } else {
      ids.forEach((id) => selectedFiles.value.delete(id))
    }

    // 同步到DragSelect实例
    syncSelectionToDragSelect()
  }

  // 切换选中状态
  const toggleSelected = (fileId: string) => {
    selectionVersion++
    if (selectedFiles.value.has(fileId)) {
      selectedFiles.value.delete(fileId)
    } else {
      selectedFiles.value.add(fileId)
    }
    syncSelectionToDragSelect()
  }

  /**
   * 清空选择并重置锚点
   */
  const clearSelection = () => {
    selectionVersion++
    selectedFiles.value.clear()
    preSelectionSnapshot.value.clear()
    anchorFileId.value = null
    if (dragSelectInstance.value) {
      dragSelectInstance.value.clearSelection()
    }
  }

  // 全选
  const selectAll = (fileIds: string[]) => {
    selectionVersion++
    selectedFiles.value = new Set(fileIds)
    syncSelectionToDragSelect()
  }

  /**
   * 仅选择文件（排除文件夹），用于 Ctrl+A 第一次按下
   */
  const selectOnlyFiles = () => {
    if (!containerRef.value) return
    selectAll(
      getItems()
        .filter((item) => item.type === 'file')
        .map((item) => item.id)
    )
  }

  const selectOnlyFolders = () => {
    selectAll(
      getItems()
        .filter((item) => item.type === 'folder')
        .map((item) => item.id)
    )
  }

  const selectFilesAndFolders = () => {
    selectAll(getItems().map((item) => item.id))
  }

  // 同步选择状态到DragSelect实例
  const syncSelectionToDragSelect = async () => {
    if (!dragSelectInstance.value || !containerRef.value) return

    await nextTick()
    const elements: HTMLElement[] = []

    selectedFiles.value.forEach((fileId) => {
      const element = containerRef.value?.querySelector(`[data-file-id="${fileId}"]`) as HTMLElement
      if (element) {
        elements.push(element)
      }
    })

    dragSelectInstance.value.setSelection(elements)
  }

  // 检查是否选中
  const isSelected = (fileId: string) => {
    return selectedFiles.value.has(fileId)
  }

  // 获取选中的文件数量
  const getSelectedCount = () => {
    return selectedFiles.value.size
  }

  // 获取选中的文件ID列表
  const getSelectedIds = () => {
    return Array.from(selectedFiles.value)
  }

  // 实时获取鼠标是否在已选中文件DOM上的状态
  const getIsMouseOnSelectedFile = (target?: HTMLElement | EventTarget | null): boolean => {
    let base: HTMLElement | null = null

    // 优先使用传入的目标
    if (target) {
      base = target as HTMLElement
    }

    // 其次使用最新鼠标位置进行命中测试
    if (!base && lastMousePos.value) {
      const el = document.elementFromPoint(lastMousePos.value.x, lastMousePos.value.y)
      base = (el as HTMLElement) || null
    }

    // 最后回退到最近一次 mousedown 的目标
    if (!base && mouseDownInfo.value?.target) {
      base = mouseDownInfo.value.target as HTMLElement
    }

    if (!base) return false

    const fileItem = base.closest('.file-item') as HTMLElement | null
    if (!fileItem) return false
    const fileId = fileItem.getAttribute('data-file-id')
    return fileId ? selectedFiles.value.has(fileId) : false
  }

  // 新增：实时判断鼠标是否位于任意文件项上（不考虑选中状态）
  const getIsMouseOnFileItem = (target?: HTMLElement | EventTarget | null): boolean => {
    let base: HTMLElement | null = null

    if (target) {
      base = target as HTMLElement
    }
    if (!base && lastMousePos.value) {
      const el = document.elementFromPoint(lastMousePos.value.x, lastMousePos.value.y)
      base = (el as HTMLElement) || null
    }
    if (!base && mouseDownInfo.value?.target) {
      base = mouseDownInfo.value.target as HTMLElement
    }
    if (!base) return false

    return !!base.closest('.file-item')
  }

  // 判断当前选择中是否包含文件夹，用于 Ctrl+A 策略切换
  const hasSelectedFolder = (): boolean => {
    return getItems().some((item) => item.type === 'folder' && selectedFiles.value.has(item.id))
  }

  /**
   * 处理单击事件
   * Windows 标准行为：
   * - 普通点击：单选，设置锚点
   * - Ctrl+点击：切换选中状态，设置锚点
   * - Shift+点击：从锚点到当前项的范围选择
   */
  const handleItemClick = (fileId: string, event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()

    if (event.ctrlKey || event.metaKey) {
      // Ctrl/Cmd + 点击：切换选中状态，并更新锚点
      toggleSelected(fileId)
      anchorFileId.value = fileId
    } else if (event.shiftKey) {
      // Shift + 点击：从锚点范围选择（即使当前没有选中项也可以使用）
      handleShiftSelection(fileId)
    } else {
      // 普通点击：单选，设置锚点
      clearSelection()
      setSelected(fileId, true)
      anchorFileId.value = fileId
    }
  }

  /**
   * 处理 Shift 范围选择
   * Windows 标准行为：从锚点到目标的范围选择，清除范围外的选择
   * @param targetFileId 目标文件ID
   */
  const handleShiftSelection = (targetFileId: string) => {
    selectionVersion++
    if (!containerRef.value) return

    const fileIds = getItems().map((item) => item.id)

    // 如果没有锚点，使用目标作为起点和锚点
    if (!anchorFileId.value) {
      clearSelection()
      setSelected(targetFileId, true)
      anchorFileId.value = targetFileId
      return
    }

    const anchorIndex = fileIds.indexOf(anchorFileId.value)
    const targetIndex = fileIds.indexOf(targetFileId)

    // 如果锚点或目标不在列表中，回退到单选行为
    if (anchorIndex === -1 || targetIndex === -1) {
      clearSelection()
      setSelected(targetFileId, true)
      anchorFileId.value = targetFileId
      return
    }

    // 计算范围（从锚点到目标）
    const startIndex = Math.min(anchorIndex, targetIndex)
    const endIndex = Math.max(anchorIndex, targetIndex)

    // 清除旧选择，选择范围内的所有文件
    const newSelection = new Set<string>()
    for (let i = startIndex; i <= endIndex; i++) {
      newSelection.add(fileIds[i])
    }
    selectedFiles.value = newSelection

    // 同步到 DragSelect 实例
    syncSelectionToDragSelect()
    // 注意：锚点保持不变，允许连续 Shift+点击调整范围
  }

  /**
   * 检查当前容器是否处于活动状态
   * 确保只有在用户实际位于资产库页面时才响应键盘事件
   */
  const isContainerActive = (): boolean => {
    if (!containerRef.value) return false

    // 检查容器是否可见
    const rect = containerRef.value.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false

    // 检查容器是否在视口中
    if (rect.top > window.innerHeight || rect.bottom < 0) return false

    return true
  }

  /**
   * 判断当前是否有模态框/弹窗/下拉等覆盖层处于打开状态
   * 避免快捷键误触影响弹窗交互
   */
  const isOverlayActive = (): boolean => {
    const isVisible = (selector: string) => {
      const elements = document.querySelectorAll(selector)
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i] as HTMLElement
        if (el.offsetParent !== null && getComputedStyle(el).display !== 'none') {
          return true
        }
      }
      return false
    }

    const hasModal = isVisible('.ant-modal')
    const hasDrawer = isVisible('.ant-drawer')
    const hasPopover = isVisible('.ant-popover')
    const hasDropdown = isVisible('.ant-dropdown:not(.ant-dropdown-hidden)')
    const hasContextMenu = isVisible('.context-menu')

    return hasModal || hasDrawer || hasPopover || hasDropdown || hasContextMenu
  }

  /**
   * 判断是否有输入框或可编辑元素处于焦点，以避免拦截输入
   */
  const isInputFocused = (): boolean => {
    const active = document.activeElement as HTMLElement | null
    if (!active) return false
    const tag = active.tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea') return true
    if (active.isContentEditable) return true
    return false
  }

  // 处理键盘事件
  const handleKeyDown = async (event: KeyboardEvent): Promise<void> => {
    // 只在容器活动时响应键盘事件
    if (!isContainerActive()) return

    // 弹窗/输入聚焦时不响应快捷键
    if (isOverlayActive() || isInputFocused()) return

    if (!containerRef.value) return

    switch (event.key) {
      case 'Escape':
        clearSelection()
        break
      case 'a':
      case 'A':
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault()
          if (selectingAll) return
          const version = selectionVersion
          selectingAll = true
          try {
            if (options.loadAll && !(await options.loadAll())) return
            if (version !== selectionVersion) return
          } finally {
            selectingAll = false
          }
          const now = Date.now()
          const isDoublePress = now - lastCtrlATime.value <= 500
          lastCtrlATime.value = now
          // 当未选中任何项时，直接全选（文件+文件夹）
          if (selectedFiles.value.size === 0) {
            selectFilesAndFolders()
            break
          }
          if (isDoublePress) {
            selectFilesAndFolders()
          } else {
            const hasFiles = getItems().some((item) => item.type === 'file')
            const hasFolders = getItems().some((item) => item.type === 'folder')
            // 若当前已选中文件夹，优先选择全部文件夹，再次按下再进入全选
            if (hasSelectedFolder()) {
              if (hasFolders) {
                selectOnlyFolders()
              } else {
                selectFilesAndFolders()
              }
            } else {
              // 保持原有文件优先的行为
              if (hasFiles) {
                selectOnlyFiles()
              } else {
                selectFilesAndFolders()
              }
            }
          }
        }
        break
      case 'd':
      case 'D':
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault()
          if (selectedFiles.value.size > 0) {
            onToggleFavoriteSelected?.(Array.from(selectedFiles.value))
          }
        }
        break
      case 'F2':
        event.preventDefault()
        if (selectedFiles.value.size > 0) {
          const firstId = Array.from(selectedFiles.value)[0]
          onInlineRename?.(firstId)
        }
        break
      // 删除只认 Delete。
      //
      // Backspace 曾经也在这里，删掉是因为它在 Windows 上的通用含义是「退格 / 返回上一级」，
      // 而在「最近删除」视图里这一下是**永久**删除。误按一个退格键就把硬盘上的备份副本
      // 抹掉，代价和这个键给人的心理预期完全不成比例。
      case 'Delete':
        if (selectedFiles.value.size > 0) {
          event.preventDefault()
          // 触发删除事件（可以通过回调函数处理）
          onDeleteSelected?.(Array.from(selectedFiles.value))
        }
        break
      case 'b':
      case 'B':
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault()
          onLocateInFolder?.()
        }
        break
    }
  }

  // 删除选中文件的回调
  let onDeleteSelected: ((fileIds: string[]) => void) | undefined

  // 设置删除回调
  const setDeleteCallback = (callback: (fileIds: string[]) => void) => {
    onDeleteSelected = callback
  }

  // 在文件夹视图中显示的回调（Ctrl+B）
  let onLocateInFolder: (() => void) | undefined

  // 设置在文件夹视图中显示回调
  const setLocateInFolderCallback = (callback: () => void) => {
    onLocateInFolder = callback
  }

  /**
   * 设置收藏切换回调，用于 Ctrl + D
   */
  const setFavoriteToggleCallback = (callback: (fileIds: string[]) => void) => {
    onToggleFavoriteSelected = callback
  }

  /**
   * 设置行内重命名回调，用于 F2
   */
  const setInlineRenameCallback = (callback: (fileId: string) => void) => {
    onInlineRename = callback
  }

  // 处理鼠标按下事件
  const handleMouseDown = (event: MouseEvent) => {
    const target = event.target as HTMLElement

    // 更新最新鼠标位置
    lastMousePos.value = { x: event.clientX, y: event.clientY }

    // 若当前没有选中项，且鼠标按在某个文件项上（无修饰键），则立即单选该文件
    // 若鼠标按在某个文件项上（无修饰键）
    // 1. 如果该文件未被选中，则立即选中它（同时清除其他），以便于后续可能的拖拽
    // 2. 如果该文件已被选中，则保持现状（支持多选拖拽）
    const fileItemEl = target.closest('.file-item') as HTMLElement | null
    if (fileItemEl && !(event.shiftKey || event.ctrlKey || event.metaKey)) {
      const fileId = fileItemEl.getAttribute('data-file-id')
      if (fileId) {
        if (!selectedFiles.value.has(fileId)) {
          clearSelection()
          setSelected(fileId, true)
        }
        // 标记鼠标在已选中项上
        isMouseOnSelectedFile.value = true
      } else {
        isMouseOnSelectedFile.value = false
      }
    } else {
      // 否则（点击空地、或按住了修饰键），按当前状态判断
      isMouseOnSelectedFile.value = getIsMouseOnSelectedFile(target)
    }

    // 记录鼠标按下的位置和时间
    mouseDownInfo.value = {
      x: event.clientX,
      y: event.clientY,
      time: Date.now(),
      target: target,
      isOnFileItem: !!fileItemEl
    }
  }

  // 处理鼠标松开事件
  const handleMouseUp = (event: MouseEvent) => {
    const target = event.target as HTMLElement

    // 更新最新鼠标位置
    lastMousePos.value = { x: event.clientX, y: event.clientY }

    // 更新鼠标是否在已选中文件DOM上的状态（通过方法实时计算）
    isMouseOnSelectedFile.value = getIsMouseOnSelectedFile(target)

    // 如果正在拖拽选择，不处理
    if (isDragSelecting.value) {
      return
    }

    // 检查是否是简单点击（而不是拖拽）
    if (mouseDownInfo.value) {
      const timeDiff = Date.now() - mouseDownInfo.value.time
      const distanceX = Math.abs(event.clientX - mouseDownInfo.value.x)
      const distanceY = Math.abs(event.clientY - mouseDownInfo.value.y)
      const distance = Math.sqrt(distanceX * distanceX + distanceY * distanceY)

      const isClick = timeDiff < 300 && distance < 5
      const isOnFileItem = !!target.closest('.file-item')

      // 如果是点击操作且不在文件项上，清空选择
      if (isClick && !isOnFileItem && !mouseDownInfo.value.isOnFileItem) {
        clearSelection()
      }
    }

    // 重置鼠标按下信息
    mouseDownInfo.value = null
  }

  // 鼠标按下信息跟踪
  const mouseDownInfo = ref<{
    x: number
    y: number
    time: number
    target: HTMLElement
    isOnFileItem: boolean
  } | null>(null)

  // 拖拽选择状态
  const isDragSelecting = ref(false)

  // 鼠标是否在已选中文件的DOM上
  const isMouseOnSelectedFile = ref(false)

  // 记录框选开始时的修饰键状态
  const dragStartModifiers = ref({
    shiftKey: false,
    ctrlKey: false,
    metaKey: false
  })

  // 记录框选开始时的已选择项（用于Shift键累加）
  const preSelectionSnapshot = ref<Set<string>>(new Set())

  /**
   * 销毁 DragSelect 实例
   * 使用 try-catch 包裹，防止在 DOM 已被清理的情况下抛出 removeChild 错误
   */
  const destroyDragSelect = (): void => {
    if (dragSelectInstance.value) {
      try {
        dragSelectInstance.value.stop()
      } catch (error) {
        // 忽略 DOM 已被清理导致的错误（如 NotFoundError: removeChild）
        console.warn('[DragSelect] destroyDragSelect 调用 stop() 时发生错误（已忽略）:', error)
      }
      dragSelectInstance.value = null
    }
  }

  /**
   * 暂停框选（例如在重命名输入框出现时或 HTML5 拖拽开始时调用）
   */
  const pauseDragSelect = (): void => {
    console.log('[DragSelect] pauseDragSelect 调用', {
      hasInstance: !!dragSelectInstance.value,
      isDragSelecting: isDragSelecting.value,
      isMouseOnSelectedFile: isMouseOnSelectedFile.value,
      mouseDownInfo: mouseDownInfo.value ? 'exists' : 'null'
    })

    if (dragSelectInstance.value) {
      dragSelectInstance.value.stop(false, false, true)
      console.log('[DragSelect] DragSelect 实例已停止')
    }
    // 清除鼠标按下状态，防止因原生拖拽导致 pointerup 丢失而残留陈旧的目标信息
    mouseDownInfo.value = null
    isMouseOnSelectedFile.value = false
  }

  /**
   * 恢复框选功能
   * 在 HTML5 拖拽或行内编辑结束后调用，确保框选功能恢复正常
   */
  const resumeDragSelect = async (): Promise<void> => {
    console.log('[DragSelect] resumeDragSelect 调用（恢复前状态）', {
      hasInstance: !!dragSelectInstance.value,
      isDragSelecting: isDragSelecting.value,
      isMouseOnSelectedFile: isMouseOnSelectedFile.value,
      mouseDownInfo: mouseDownInfo.value ? 'exists' : 'null',
      lastMousePos: lastMousePos.value
    })

    // 重置框选相关状态，确保下次鼠标按下时能正常启动框选
    isDragSelecting.value = false
    mouseDownInfo.value = null
    isMouseOnSelectedFile.value = false

    // 重新初始化 DragSelect 实例，因为 stop/start 后事件订阅可能丢失
    if (containerRef.value) {
      console.log('[DragSelect] resumeDragSelect: 重新初始化 DragSelect 实例')
      await initDragSelect(containerRef.value)
      console.log('[DragSelect] resumeDragSelect: DragSelect 实例已重新初始化')
    } else {
      console.warn('[DragSelect] resumeDragSelect: containerRef 为空!')
    }

    console.log('[DragSelect] resumeDragSelect 完成（恢复后状态）', {
      isDragSelecting: isDragSelecting.value,
      isMouseOnSelectedFile: isMouseOnSelectedFile.value,
      mouseDownInfo: mouseDownInfo.value ? 'exists' : 'null'
    })
  }

  // 添加键盘事件监听
  onMounted(() => {
    document.addEventListener('keydown', handleKeyDown)
    // 绑定 mousemove 以记录最新鼠标位置
    document.addEventListener('mousemove', handleMouseMove)
  })

  onUnmounted(() => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    destroyDragSelect()
    document.removeEventListener('keydown', handleKeyDown)
    // 解绑 mousemove 监听
    document.removeEventListener('mousemove', handleMouseMove)
  })

  return {
    selectedFiles,
    containerRef,
    initDragSelect,
    updateSelectables,
    setSelected,
    toggleSelected,
    clearSelection,
    selectAll,
    selectOnlyFiles,
    selectOnlyFolders,
    selectFilesAndFolders,
    isSelected,
    getSelectedCount,
    getSelectedIds,
    handleItemClick,
    handleMouseDown,
    handleMouseUp,
    setDeleteCallback,
    setFavoriteToggleCallback,
    setInlineRenameCallback,
    setLocateInFolderCallback,
    destroyDragSelect,
    isMouseOnSelectedFile,
    getIsMouseOnSelectedFile,
    pauseDragSelect,
    resumeDragSelect
  }
}

// 鼠标位置跟踪（用于 elementFromPoint 实时判定）
const lastMousePos = ref<{ x: number; y: number } | null>(null)

// 处理鼠标移动，记录最新坐标
const handleMouseMove = (event: MouseEvent) => {
  lastMousePos.value = { x: event.clientX, y: event.clientY }
}
