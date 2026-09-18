import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useTabsStore } from '@renderer/store/modules/tabs'
import { useAssetFolderStore } from '@renderer/store/modules/assetFolder'
import { noteAPI } from '@renderer/api/note'
import i18n from '@renderer/i18n'
import { message } from '@renderer/utils/messageManager'
import { marked } from 'marked'
/** 这是 hook 不是组件，拿不到 `useI18n()`；`i18n.global.t` 每次调用现读当前语言 */
const t = i18n.global.t

/**
 * Spotlight 操作处理数据接口
 */
interface SpotlightActionData {
  // 项目操作
  projectKey?: string
  projectPath?: string
  originPath?: string
  engineAssociation?: string

  // 资产操作
  assetKey?: string
  folderKey?: string
  filePath?: string

  // AI 对话
  message?: string

  // 笔记保存
  content?: string
}

/**
 * 处理来自 Spotlight 的操作
 * 在主窗口中监听并执行相应操作
 */
export function useSpotlightAction() {
  const router = useRouter()
  const tabsStore = useTabsStore()
  const assetFolderStore = useAssetFolderStore()

  /**
   * 处理 Spotlight 操作
   */
  function handleSpotlightAction(
    _event: unknown,
    actionType: string,
    data: SpotlightActionData
  ): void {
    console.log('[SpotlightAction] 收到操作:', actionType, data)

    switch (actionType) {
      case 'project':
        handleOpenProject(data)
        break
      case 'asset':
        handleNavigateToAsset(data)
        break
      case 'ai':
        handleAIChat(data)
        break
      case 'note':
        handleSaveNote(data)
        break
      default:
        console.warn('[SpotlightAction] 未知操作类型:', actionType)
    }
  }

  /**
   * 打开项目
   */
  async function handleOpenProject(data: SpotlightActionData): Promise<void> {
    const projectPath = data.originPath || data.projectPath
    if (!projectPath) {
      console.error('[SpotlightAction] 项目路径为空')
      return
    }

    try {
      // 使用 shell 打开项目文件。返回值必须看：失败时是 return {success:false}，不抛 ——
      // 原来这儿无条件打印「项目已打开」，路径没了也照样说打开了，等于骗自己也骗用户
      const result = await window.api.shell.openPath(projectPath)
      if (result?.success) {
        console.log('[SpotlightAction] 项目已打开:', projectPath)
      } else {
        console.error('[SpotlightAction] 打开项目失败:', projectPath, result?.error)
        message.error(
          result?.pathNotFound
            ? `工程文件不在了：${projectPath}`
            : `打不开工程：${projectPath}（${result?.error || ''}）`,
          8
        )
      }
    } catch (error) {
      console.error('[SpotlightAction] 打开项目失败:', error)
      message.error(`打不开工程：${projectPath}`, 8)
    }
  }

  /**
   * 导航到资产
   */
  async function handleNavigateToAsset(data: SpotlightActionData): Promise<void> {
    const { folderKey, assetKey } = data
    if (!folderKey) {
      console.error('[SpotlightAction] 资产文件夹键为空')
      return
    }

    console.log('[SpotlightAction] 导航到资产中:', folderKey, assetKey)

    try {
      // 1. 确保资产管理标签页打开并激活
      await router.push('/asset-management')
      tabsStore.setActiveTab('/asset-management')

      // 2. 设置文件夹（无论是否已在页面都需要执行）
      // 使用 requestAnimationFrame 确保 DOM 更新后再设置
      requestAnimationFrame(() => {
        // 设置选中的文件夹
        assetFolderStore.setSelectedFolder(folderKey)
        console.log('[SpotlightAction] 已设置文件夹:', folderKey)

        // 3. 如果有 assetKey，选中该资产
        if (assetKey) {
          // 监听文件夹变更事件后再选中资产
          const selectAsset = (): void => {
            window.dispatchEvent(
              new CustomEvent('spotlight:select-asset', { detail: { assetKey } })
            )
            console.log('[SpotlightAction] 已触发资产选中:', assetKey)
          }

          // 延迟执行确保文件列表加载完成
          setTimeout(selectAsset, 600)
        }
      })
    } catch (error) {
      console.error('[SpotlightAction] 导航到资产失败:', error)
    }
  }

  /**
   * 发送 AI 消息
   */
  async function handleAIChat(data: SpotlightActionData): Promise<void> {
    const chatMessage = data.message
    if (!chatMessage) {
      console.error('[SpotlightAction] AI 消息为空')
      return
    }

    try {
      // 1. 导航到 AI 助手标签页，带上初始消息参数
      await router.push({
        path: '/dev-assistant',
        query: { initialMessage: chatMessage }
      })
      tabsStore.setActiveTab('/dev-assistant')

      console.log('[SpotlightAction] 已导航到 AI 助手，初始消息:', chatMessage)
    } catch (error) {
      console.error('[SpotlightAction] 发送 AI 消息失败:', error)
    }
  }

  /**
   * 保存内容到笔记
   */
  /**
   * 保存内容到笔记
   */
  async function handleSaveNote(data: SpotlightActionData): Promise<void> {
    const rawContent = data.content
    if (!rawContent) {
      console.error('[SpotlightAction] 笔记内容为空')
      return
    }

    try {
      // 1. 将 Markdown 内容转换为 HTML
      // 配置 breaks: true 使得换行符被转换为 <br>
      const htmlContent = await marked(rawContent, { async: true, breaks: true, gfm: true })

      // 2. 创建新笔记，标题取前20个字符
      const title = rawContent.slice(0, 20) + (rawContent.length > 20 ? '...' : '')
      const noteId = await noteAPI.create({
        title,
        content: htmlContent, // 使用转换后的 HTML 内容
        sync_status: 'local-only',
        is_shared: false
      })

      console.log('[SpotlightAction] 笔记已创建, ID:', noteId)
      message.success(t('actionToast.notebook.savedToNote'))

      // 3. 导航到笔记编辑器并选中新创建的笔记
      await router.push({
        path: '/note-editor',
        query: { noteId: noteId.toString() }
      })
      tabsStore.setActiveTab('/note-editor')
    } catch (error) {
      console.error('[SpotlightAction] 保存笔记失败:', error)
      message.error(t('actionToast.notebook.saveNoteFailed'))
    }
  }

  /**
   * 初始化监听器
   */
  function init(): void {
    window.electron?.ipcRenderer.on('spotlight:action', handleSpotlightAction)
  }

  /**
   * 销毁监听器
   */
  function destroy(): void {
    window.electron?.ipcRenderer.removeListener('spotlight:action', handleSpotlightAction)
  }

  /**
   * 在组件生命周期中自动初始化和销毁
   */
  function useLifecycle(): void {
    onMounted(() => {
      init()
    })

    onUnmounted(() => {
      destroy()
    })
  }

  return {
    init,
    destroy,
    useLifecycle,
    handleSpotlightAction
  }
}
