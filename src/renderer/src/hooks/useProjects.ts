import { rankProjectSearch } from '@renderer/utils/projectSearch'
import { ref, computed } from 'vue'
import { notifyPluginInstallFailure } from '@renderer/hooks/usePluginInstallNotice'
import i18n from '@renderer/i18n'
import { message } from '@/utils/messageManager'
import { toLocalResourceUrl } from '@renderer/utils/localResource'
import defaultProjectDarkImg from '@renderer/assets/imgs/fixme.jpg'
import defaultProjectLightImg from '@renderer/assets/imgs/fixme-light.jpg'
import { useTheme } from '@renderer/hooks/useTheme'
/** 这是 hook 不是组件，拿不到 `useI18n()`；`i18n.global.t` 每次调用现读当前语言 */
const t = i18n.global.t

export function useProjects() {
  const { isLight } = useTheme()
  const projects = ref<ProjectRecord[]>([])
  const loading = ref(false)
  /**
   * 上一趟加载失败了。
   *
   * 失败时 `projects` 留在空数组，页面光看长度会把「没读出来」当成「一个都没有」，
   * 于是对着有 12 个工程的用户说「暂无项目，拖一个 .uproject 进来」。
   * toast 会消失，那句话不会。
   */
  const loadFailed = ref(false)
  const keyword = ref('')

  const filteredProjects = computed(() => rankProjectSearch(projects.value, keyword.value))
  let loadGeneration = 0

  async function loadAllProjects() {
    // Imports and library-change notifications can load concurrently; only the latest may publish.
    const generation = ++loadGeneration
    loading.value = true
    try {
      const res = await window.api.database.project.getAll()
      if (generation !== loadGeneration) return
      if (res?.success) {
        const rows = res.data || []
        // 数据库存储的 image 可能是：
        // 1. 远程图片 URL（https://...）- 自定义封面，直接使用
        // 2. 文件名 - 需要转换为 file:/// URL
        // 3. file:/// URL - 直接使用
        const mapped = await Promise.all(
          rows.map(async (p) => {
            const img = String(p.image || '')
            // 如果是完整 URL（http/https 或 file:///），直接使用
            if (
              img.startsWith('http://') ||
              img.startsWith('https://') ||
              img.startsWith('file:')
            ) {
              return p
            }
            // 否则是文件名，需要转换为 file:/// URL
            if (img) {
              const ret = await window.api.path.getPublicThumbnailUrl(img)
              if (ret?.success && ret.data) {
                return { ...p, image: ret.data }
              }
            }
            return p
          })
        )
        if (generation !== loadGeneration) return
        projects.value = mapped
        loadFailed.value = false
      } else {
        loadFailed.value = true
        message.error(res?.error || '加载项目列表失败')
      }
    } catch (err: any) {
      if (generation !== loadGeneration) return
      loadFailed.value = true
      message.error(err?.message || '加载项目列表异常')
    } finally {
      if (generation === loadGeneration) loading.value = false
    }
  }

  async function importByFilePath(filePath: string): Promise<ProjectRecord | undefined> {
    loading.value = true
    try {
      const res = await window.api.database.project.importByFilePath(filePath)
      if (res?.success) {
        await loadAllProjects()
        message.success(t('actionToast.project.importOk'))
        notifyPluginInstallFailure(res)
        return res.data
      } else {
        message.error(res?.error || t('page.home.project.importToast.fileFailedPlain'))
      }
    } catch (err: any) {
      message.error(err?.message || t('page.home.project.importToast.fileExceptionPlain'))
    } finally {
      loading.value = false
    }
    return undefined
  }

  async function handleImportSingle(): Promise<ProjectRecord | undefined> {
    try {
      const ret = await window.api.dialog.showOpenDialog({
        title: t('actionToast.project.pickUproject'),
        properties: ['openFile'],
        filters: [{ name: 'Unreal Project', extensions: ['uproject'] }]
      })
      const filePath = ret?.filePaths?.[0]
      if (!ret?.canceled && filePath) {
        return await importByFilePath(filePath)
      }
    } catch (err: any) {
      message.error(err?.message || '打开文件对话框失败')
    }
    return undefined
  }

  async function handleImportDirectory() {
    loading.value = true
    try {
      const ret = await window.api.dialog.showOpenDialog({
        title: t('actionToast.project.pickUprojectDir'),
        properties: ['openDirectory']
      })
      const startPath = ret?.filePaths?.[0]
      if (!ret?.canceled && startPath) {
        const res = await window.api.database.project.importByDirectory(startPath)
        if (res?.success) {
          await loadAllProjects()
          const total = res.data?.total ?? 0
          message.success(t('actionToast.project.importedCount', { count: total }))
        } else {
          message.error(res?.error || t('page.home.project.importToast.scanImportFailed'))
        }
      }
    } catch (err: any) {
      message.error(err?.message || '打开目录对话框失败')
    } finally {
      loading.value = false
    }
  }

  function getProjectImage(p: ProjectRecord): string {
    // 库里存的可能是 file:/// URL（dev 模式下加载不了），统一转成 local-resource://
    return (
      toLocalResourceUrl(p.image) ||
      (isLight.value ? defaultProjectLightImg : defaultProjectDarkImg)
    )
  }

  // 这里**不自己发起首次加载**。谁用谁在自己的 onMounted 里 await ——
  // 由 hook 偷偷发起的话，页面等不到它，于是有 12 个工程的用户会先看到
  // 「暂无项目，拖一个进来」；而不需要列表的调用方（只用 getProjectImage 的那些）
  // 还会白白多跑一趟 getAll + 每个工程一次缩略图 IPC。

  return {
    projects,
    loading,
    loadFailed,
    keyword,
    filteredProjects,
    loadAllProjects,
    handleImportSingle,
    handleImportDirectory,
    getProjectImage
  }
}
