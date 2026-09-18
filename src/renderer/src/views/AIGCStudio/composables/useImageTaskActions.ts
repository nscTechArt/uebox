/**
 * 一张生成图能做的事，只有这一份清单。
 *
 * 中间的大图预览和右侧的历史卡片，是**同一条生成记录的两个入口**。
 * 以前两边各写各的：卡片能删能定位、不能复制不能转参考；大图能转参考能复制、
 * 不能定位不能删。同一张图，动作要去哪儿找得靠记，记错了就以为功能不存在。
 *
 * 现在两边都从这里取：图标、文案、可用条件一处定义。
 * 平铺几个按各自空间决定（大图宽、卡片窄），但「⋯」里永远是**完整的一份**，
 * 两边逐字相同 —— 找不到就点「⋯」，这条规则在哪儿都成立。
 *
 * 动作在这里只是「定义」，真正干活的在 {@link useImageTaskActionRunner}，
 * 由 AIGCStudio/index.vue 独家持有：填表单和加参考图要通过 ref 打到
 * **当前这一页**的 ImagePanel 上，走事件总线会打到每一个标签页去。
 */
import type { Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  PhClipboardText,
  PhCopy,
  PhDownloadSimple,
  PhFolderOpen,
  PhImage,
  PhPencilSimple,
  PhTrash
} from '@phosphor-icons/vue'

import { message } from '@renderer/utils/messageManager'
import { confirmDialog } from '@renderer/utils/dialog'
import { blobToDataUrl, copyImageToClipboard, loadImageBlob } from '@renderer/utils/imageBlob'

import { getTaskDisplayUrls, useImageStudioStore, type ImageGenerationTask } from '../imageStore'
import { useVaultStore } from '../../../store/modules/vaultStore'

export type ImageTaskActionKey =
  | 'useAsReference'
  | 'copyImage'
  | 'download'
  | 'useParams'
  | 'copyPrompt'
  | 'locate'
  | 'delete'

export interface ImageTaskActionDef {
  key: ImageTaskActionKey
  icon: Component
  /** i18n 键。两处共用同一条，文案不会各自漂移 */
  labelKey: string
  /** 危险动作，菜单里标红 */
  danger?: boolean
}

/** 完整清单，也是「⋯」里的排列顺序 */
export const IMAGE_TASK_ACTIONS: readonly ImageTaskActionDef[] = [
  { key: 'useAsReference', icon: PhImage, labelKey: 'aigcImageActions.useAsReference' },
  { key: 'copyImage', icon: PhCopy, labelKey: 'aigcImageActions.copyImage' },
  { key: 'download', icon: PhDownloadSimple, labelKey: 'aigcImageActions.download' },
  { key: 'useParams', icon: PhPencilSimple, labelKey: 'aigcImageActions.useParams' },
  { key: 'copyPrompt', icon: PhClipboardText, labelKey: 'aigcImageActions.copyPrompt' },
  { key: 'locate', icon: PhFolderOpen, labelKey: 'aigcImageActions.locate' },
  { key: 'delete', icon: PhTrash, labelKey: 'aigcImageActions.delete', danger: true }
] as const

/** 一条记录当下的状态，决定哪些动作有意义 */
export interface ImageTaskActionContext {
  /** 有没有图片可以复制 / 转参考 / 下载 */
  hasImage: boolean
  /** 有没有提示词可以复制 / 回填 */
  hasPrompt: boolean
  /** 生成成功的图才在资产库里有落点 */
  isCompleted: boolean
}

/** 按当前状态过滤出可用动作。两处调用同一个函数，不会一边多一边少 */
export function getAvailableImageTaskActions(
  context: ImageTaskActionContext
): ImageTaskActionDef[] {
  return IMAGE_TASK_ACTIONS.filter((action) => {
    switch (action.key) {
      case 'useAsReference':
      case 'copyImage':
      case 'download':
        return context.hasImage
      case 'useParams':
      case 'copyPrompt':
        return context.hasPrompt
      case 'locate':
        return context.isCompleted
      case 'delete':
        return true
      default:
        return true
    }
  })
}

/** 动作要作用在哪条记录的第几张图上 */
export interface ImageTaskActionPayload {
  task: ImageGenerationTask | null
  /** 多视图任务一条记录四张图；大图区传当前翻到的那张，卡片传首图 */
  index: number
}

export interface ImageTaskActionHandlers {
  /** 把整套参数回填到左侧面板（提示词、参考图、模型、比例……） */
  fillForm: (task: ImageGenerationTask) => void
  /** 把这张图加进参考图 */
  addToReference: (imageUrl: string) => void
}

export interface ImageTaskActionRunner {
  /** 跑一个动作。两个面板都把动作交到这里，行为只有一份 */
  run: (key: ImageTaskActionKey, payload: ImageTaskActionPayload) => Promise<void>
  /** 单独拿出来给「打开资产库」那个链接用 */
  locateInAssetVault: () => Promise<void>
}

/**
 * 动作的实现。只在 AIGCStudio/index.vue 里 setup 一次。
 */
export function useImageTaskActionRunner(handlers: ImageTaskActionHandlers): ImageTaskActionRunner {
  const { t } = useI18n()
  const router = useRouter()
  const imageStore = useImageStudioStore()
  const vaultStore = useVaultStore()

  /**
   * 拿一张能在界面里显示、也能被 fetch 的地址（复制、转参考用）。
   * 和预览、缩略图同一套解析，本地副本优先。
   */
  function displayUrlOf(task: ImageGenerationTask | null, index: number): string | null {
    const urls = getTaskDisplayUrls(task)
    return urls[index] || urls[0] || null
  }

  /**
   * 拿一份用来落盘的源。
   *
   * 本地副本优先：`imageUrls` 是模型那边给的地址，远端链接会过期、base64 又特别长，
   * 而 `localPaths` 是已经存进资产库的那份，只要文件还在就一定存得下来。
   */
  function downloadSourceOf(task: ImageGenerationTask | null, index: number): string | null {
    return (
      task?.localPaths?.[index] ||
      task?.imageUrls?.[index] ||
      task?.localPaths?.[0] ||
      task?.imageUrls?.[0] ||
      null
    )
  }

  /**
   * 转参考图。
   *
   * 先把图读成 base64 再交给左侧面板：参考图是要发出去给模型的，
   * `local-resource://` 只有这个应用自己认得，模型给的远端链接又会过期。
   * 从文件拖进来的参考图走的也是 base64，这里保持一致。
   */
  async function useAsReference(task: ImageGenerationTask | null, index: number): Promise<void> {
    const src = displayUrlOf(task, index)
    if (!src) {
      message.warning(t('aigcImageActions.messages.noImage'))
      return
    }

    try {
      const dataUrl = src.startsWith('data:') ? src : await blobToDataUrl(await loadImageBlob(src))
      handlers.addToReference(dataUrl)
    } catch (error) {
      console.error('[ImageActions] 转参考图失败:', error)
      message.error(t('aigcImageActions.messages.useAsReferenceFailed'))
    }
  }

  async function copyImage(task: ImageGenerationTask | null, index: number): Promise<void> {
    const src = displayUrlOf(task, index)
    if (!src) {
      message.warning(t('aigcImageActions.messages.noImage'))
      return
    }

    try {
      await copyImageToClipboard(src)
      message.success(t('aigcImageActions.messages.imageCopied'))
    } catch (error) {
      console.error('[ImageActions] 复制图片失败:', error)
      message.error(t('aigcImageActions.messages.copyImageFailed'))
    }
  }

  async function copyPrompt(task: ImageGenerationTask | null): Promise<void> {
    const prompt = task?.prompt
    if (!prompt) return

    try {
      await navigator.clipboard.writeText(prompt)
      message.success(t('aigcImageActions.messages.promptCopied'))
    } catch (error) {
      console.error('[ImageActions] 复制提示词失败:', error)
      message.error(t('aigcImageActions.messages.copyPromptFailed'))
    }
  }

  /**
   * 另存为。走主进程的保存对话框而不是浏览器那条 `<a download>` ——
   * 用户能自己选目录，成功与否也有回执可报（失败了必须说失败）。
   */
  async function download(task: ImageGenerationTask | null, index: number): Promise<void> {
    const source = downloadSourceOf(task, index)
    if (!source) {
      message.warning(t('aigcImageActions.messages.noImage'))
      return
    }

    const cleanName =
      (task?.name || task?.prompt || 'image')
        .slice(0, 50)
        .replace(/[\r\n\t\\/:*?"<>|]/g, '_')
        .replace(/_+/g, '_')
        .trim() || 'image'
    const ext = source.match(/\.(png|jpg|jpeg|webp)(?:\?|#|$)/i)?.[1] || 'png'

    try {
      const result = await window.electron.ipcRenderer.invoke('dialog:saveFile', {
        defaultPath: `${cleanName}.${ext}`,
        filters: [
          {
            name: t('aigcImageActions.messages.imageFileFilterName'),
            extensions: ['png', 'jpg', 'jpeg', 'webp']
          }
        ],
        sourcePath: source
      })

      if (result?.success) {
        message.success(t('aigcImageActions.messages.downloadComplete'))
      } else if (!result?.canceled) {
        message.error(result?.error || t('aigcImageActions.messages.downloadFailed'))
      }
    } catch (error) {
      console.error('[ImageActions] 下载失败:', error)
      message.error(t('aigcImageActions.messages.downloadFailed'))
    }
  }

  /** 切到 AIGC 资产库的图片目录。面板标题栏那个「打开资产库」也是这一条 */
  async function locateInAssetVault(): Promise<void> {
    try {
      if (vaultStore.vaults.length === 0) {
        await vaultStore.loadVaults()
      }

      const aigcVault = vaultStore.vaults.find((vault) => vault.systemKey === 'aigc')
      if (!aigcVault) {
        message.error(t('aigcImageActions.messages.vaultNotFound'))
        return
      }

      if (vaultStore.currentVault?.id !== aigcVault.id) {
        await vaultStore.switchVault(aigcVault.id)
      }

      router.push({ path: '/asset-management', query: { folderKey: 'AIGC_image' } })
    } catch (error) {
      console.error('[ImageActions] 打开资产库失败:', error)
      message.error(
        error instanceof Error ? error.message : t('aigcImageActions.messages.openVaultFailed')
      )
    }
  }

  /**
   * 删除记录。先问一句 —— 这条路走完图和记录都回不来了，
   * 而按钮就藏在下载旁边的「⋯」里，点错的代价和点对的代价差得太远。
   */
  function confirmDelete(task: ImageGenerationTask | null): void {
    if (!task) return

    confirmDialog({
      title: t('aigcImageActions.deleteModal.title'),
      content: t('aigcImageActions.deleteModal.content'),
      okText: t('aigcImageActions.deleteModal.okText'),
      cancelText: t('aigcImageActions.deleteModal.cancelText'),
      danger: true,
      async onOk() {
        await imageStore.deleteTask(task.id)
        message.success(t('aigcImageActions.messages.recordDeleted'))
      }
    })
  }

  /** 两个面板都把动作交到这里，行为只有一份 */
  async function run(key: ImageTaskActionKey, payload: ImageTaskActionPayload): Promise<void> {
    const { task, index } = payload

    switch (key) {
      case 'useAsReference':
        await useAsReference(task, index)
        break
      case 'copyImage':
        await copyImage(task, index)
        break
      case 'download':
        await download(task, index)
        break
      case 'useParams':
        if (task) handlers.fillForm(task)
        break
      case 'copyPrompt':
        await copyPrompt(task)
        break
      case 'locate':
        await locateInAssetVault()
        break
      case 'delete':
        confirmDelete(task)
        break
      default:
        break
    }
  }

  return { run, locateInAssetVault }
}
