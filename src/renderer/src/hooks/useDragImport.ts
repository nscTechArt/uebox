import { ref, createApp } from 'vue'
import { notifyPluginInstallFailure } from '@renderer/hooks/usePluginInstallNotice'
import Antd from 'ant-design-vue'
import i18n from '@renderer/i18n'

/** 这是 composable 不是组件，拿不到 `useI18n()`；`i18n.global.t` 每次调用现读当前语言 */
const t = i18n.global.t
import { message } from '@/utils/messageManager'
import { describeRejectedDrops, filterDroppedPaths } from '@renderer/utils/droppedPathGuard'
import ProjectSelectModal from '@renderer/components/ProjectSelectModal.vue'

type DroppedEntry = {
  path: string
  isFile: boolean
  isDirectory: boolean
}

function isUprojectFile(filePath: string): boolean {
  return /\.uproject$/i.test(filePath)
}

async function getDroppedEntries(event: DragEvent): Promise<DroppedEntry[]> {
  const entries: DroppedEntry[] = []
  const files = Array.from(event.dataTransfer?.files || [])

  const rawPaths: string[] = []
  for (const file of files) {
    // Electron 32 起 File.path 没了，但旧版本上它还在，保留兜底
    const legacyPath = (file as File & { path?: string }).path
    const p = window.api.getPathForFile(file) || legacyPath || ''
    if (p) rawPaths.push(p)
  }

  // 压缩包里直接拖出来的东西不是磁盘上的文件，先挡掉再谈导入 —— 否则要么是一条
  // 谁也看不懂的 ENOENT，要么是一条会随临时目录消失的路径。
  const { accepted, rejected } = await filterDroppedPaths(rawPaths)
  for (const line of describeRejectedDrops(rejected)) {
    message.warning({ content: i18n.global.t(line.key, line.params) })
  }

  for (const p of accepted) {
    try {
      const stats = await window.api.getFileStats(p)
      entries.push({
        path: p,
        isFile: Boolean(stats?.isFile),
        isDirectory: Boolean(stats?.isDirectory)
      })
    } catch (err) {
      console.error('获取拖拽文件状态失败:', err)
    }
  }

  return entries
}

export function useDragImport() {
  const isDragOver = ref(false)
  const overlayVisible = ref(false)
  const overlayText = ref('')
  // 用于通知外部刷新列表的回调
  const onImportComplete = ref<(() => Promise<void>) | null>(null)

  // 设置导入完成回调
  const setOnImportComplete = (callback: () => Promise<void>) => {
    onImportComplete.value = callback
  }

  /**
   * 这一层只管「从系统里往窗口里拖文件」。应用内部的卡片拖拽（比如把工程拖进分组）
   * 一样会冒泡到挂着这些处理器的页面根节点上，所以每个处理器都得先认一下是不是文件拖拽，
   * 不是就彻底放手。
   *
   * 以前 dragover 是无条件 preventDefault + dropEffect='copy'，等于把内部拖拽劫走：
   * 内部拖拽声明的是 effectAllowed='move'，跟这里的 copy 对不上，浏览器把结果解析成
   * none —— 光标变成禁用图标，drop 事件根本不发，真正的放置目标怎么写都没用。
   */
  const isFileDrag = (e: DragEvent): boolean => Boolean(e.dataTransfer?.types?.includes('Files'))

  const handleDragEnter = (e: DragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    isDragOver.value = true
    overlayVisible.value = true
    const count = e.dataTransfer?.items?.length || e.dataTransfer?.files?.length || 0
    overlayText.value =
      count > 0
        ? t('page.home.project.importToast.dropCounted', { count })
        : t('page.home.project.importToast.dropPlain')
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }

  const handleDragOver = (e: DragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (e: DragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const x = e.clientX
    const y = e.clientY
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return
    }
    isDragOver.value = false
    overlayVisible.value = false
    overlayText.value = ''
  }

  const handleDrop = async (e: DragEvent) => {
    // 内部拖拽的 drop 归各自的放置目标处理，这里不能吞掉，也不该去读它的 files
    if (!isFileDrag(e)) return
    e.preventDefault()
    e.stopPropagation()

    try {
      const entries = await getDroppedEntries(e)
      if (entries.length === 0) {
        overlayVisible.value = false
        isDragOver.value = false
        return
      }

      const files = entries.filter((it) => it.isFile)
      const directories = entries.filter((it) => it.isDirectory)
      const uprojectFiles = files.filter((f) => isUprojectFile(f.path))
      const otherFiles = files.filter((f) => !isUprojectFile(f.path))

      // 1) 导入 .uproject 文件
      if (uprojectFiles.length > 0) {
        for (const f of uprojectFiles) {
          try {
            const res = await window.api.database.project.importByFilePath(f.path)
            if (res?.success) {
              message.success({
                content: t('page.home.project.importToast.fileOk', { path: f.path })
              })
              notifyPluginInstallFailure(res)
            } else {
              message.error({
                content:
                  res?.error || t('page.home.project.importToast.fileFailed', { path: f.path })
              })
            }
          } catch (err: any) {
            message.error({
              content:
                err?.message || t('page.home.project.importToast.fileException', { path: f.path })
            })
          }
        }
        // 通知外部刷新列表
        if (onImportComplete.value) {
          await onImportComplete.value()
        }
      }

      // 2) 导入目录（扫描并导入包含的 .uproject）
      for (const d of directories) {
        try {
          // 先扫描目录下的所有 .uproject 文件
          const scanRes = await window.api.database.project.scanDirectory(d.path)
          if (!scanRes?.success) {
            message.error({
              content:
                scanRes?.error || t('page.home.project.importToast.scanFailed', { path: d.path })
            })
            continue
          }

          const uprojectFiles = scanRes.data || []
          const fileCount = uprojectFiles.length

          // 如果没有找到 .uproject 文件，提示用户
          if (fileCount === 0) {
            message.warning({
              content: t('page.home.project.importToast.noUproject', { path: d.path })
            })
            continue
          }

          // 如果只有一个工程，直接导入
          if (fileCount === 1) {
            try {
              const res = await window.api.database.project.importByDirectory(d.path)
              if (res?.success) {
                const total = res?.data?.total ?? 0
                message.success({
                  content: t('page.home.project.importToast.dirOk', { count: total })
                })
              } else {
                message.error({
                  content:
                    res?.error || t('page.home.project.importToast.fileFailed', { path: d.path })
                })
              }
              // 通知外部刷新列表
              if (onImportComplete.value) {
                await onImportComplete.value()
              }
            } catch (err: any) {
              message.error({
                content:
                  err?.message || t('page.home.project.importToast.dirException', { path: d.path })
              })
              // 即使失败也尝试刷新列表
              if (onImportComplete.value) {
                try {
                  await onImportComplete.value()
                } catch (refreshErr) {
                  console.warn('刷新列表失败:', refreshErr)
                }
              }
            }
            continue
          }

          // 如果有多个工程，弹出确认框（支持勾选）
          const projectList = uprojectFiles.map((filePath: string) => {
            const pathParts = filePath.split(/[\\/]/)
            return {
              filePath,
              name: pathParts[pathParts.length - 1] || filePath
            }
          })

          // 使用 Promise 来等待用户确认
          await new Promise<void>((resolve) => {
            // 创建一个容器元素来挂载组件
            const container = document.createElement('div')
            document.body.appendChild(container)

            // 标记是否已清理，防止重复清理
            let isCleaned = false

            // 清理函数
            const cleanup = () => {
              if (isCleaned) return
              isCleaned = true

              try {
                app.unmount()
              } catch (err) {
                console.warn('卸载应用时出错:', err)
              }

              try {
                // 检查节点是否还在 DOM 中
                if (container.parentNode === document.body) {
                  document.body.removeChild(container)
                }
              } catch (err) {
                console.warn('移除容器节点时出错:', err)
              }
            }

            // 创建 Vue 应用实例
            const app = createApp(ProjectSelectModal, {
              open: true,
              directoryPath: d.path,
              projectList,
              onConfirm: async (selectedFiles: string[]) => {
                if (selectedFiles.length === 0) {
                  message.warning({ content: t('page.home.project.importToast.pickAtLeastOne') })
                  return
                }

                try {
                  // 逐个导入选中的工程
                  let successCount = 0
                  let failCount = 0
                  let skipCount = 0
                  for (const filePath of selectedFiles) {
                    try {
                      const res = await window.api.database.project.importByFilePath(filePath)
                      if (res?.success) {
                        successCount++
                      } else {
                        // 区分"已存在"和"真正的失败"
                        if (res?.error?.includes('已存在')) {
                          skipCount++
                          console.log(`项目已存在，跳过: ${filePath}`)
                        } else {
                          failCount++
                          console.error(`导入失败: ${filePath}`, res?.error)
                        }
                      }
                    } catch (err: any) {
                      failCount++
                      console.error(`导入异常: ${filePath}`, err)
                    }
                  }

                  // 生成结果消息
                  const parts: string[] = []
                  if (successCount > 0) {
                    parts.push(
                      t('page.home.project.importToast.summaryOk', { count: successCount })
                    )
                  }
                  if (skipCount > 0) {
                    parts.push(
                      t('page.home.project.importToast.summarySkipped', { count: skipCount })
                    )
                  }
                  if (failCount > 0) {
                    parts.push(
                      t('page.home.project.importToast.summaryFailed', { count: failCount })
                    )
                  }

                  if (successCount > 0) {
                    if (failCount > 0 || skipCount > 0) {
                      message.warning({
                        content: parts.join(t('page.home.project.importToast.summarySeparator'))
                      })
                    } else {
                      message.success({
                        content: t('page.home.project.importToast.partial', { count: successCount })
                      })
                    }
                  } else if (skipCount > 0) {
                    message.info({ content: t('page.home.project.importToast.allDone') })
                  } else {
                    message.error({ content: t('page.home.project.importToast.allFailed') })
                  }

                  // 清理并关闭
                  cleanup()
                  // 通知外部刷新列表
                  if (onImportComplete.value) {
                    await onImportComplete.value()
                  }
                  resolve()
                } catch (err: any) {
                  message.error({
                    content:
                      err?.message ||
                      t('page.home.project.importToast.dirException', { path: d.path })
                  })
                  cleanup()
                  // 即使失败也尝试刷新列表
                  if (onImportComplete.value) {
                    try {
                      await onImportComplete.value()
                    } catch (refreshErr) {
                      console.warn('刷新列表失败:', refreshErr)
                    }
                  }
                  resolve()
                }
              },
              onCancel: () => {
                message.info({ content: t('page.home.project.importToast.cancelled') })
                cleanup()
                resolve()
              },
              'onUpdate:open': (value: boolean) => {
                if (!value) {
                  cleanup()
                  resolve()
                }
              }
            })

            // 注册 Ant Design Vue（确保组件能正常工作）
            // 必须挂 i18n：这是一个全新的 app 实例，globalProperties 是空的。
            // ProjectSelectModal 用了 5 处 $t()，它里面的 AppModal 还在 setup 里
            // 调 useI18n() —— 不挂就直接抛「Not found vue-i18n」，弹窗根本挂不上，
            // 外面那个 Promise 也永远不会 resolve（onCancel 都没机会触发）
            app.use(i18n)
            app.use(Antd)
            // 挂载应用
            app.mount(container)
          })
        } catch (err: any) {
          message.error({
            content:
              err?.message || t('page.home.project.importToast.dirException', { path: d.path })
          })
        }
      }

      // 3) 其他文件作为普通资产导入（临时落地到 ALL）
      if (otherFiles.length > 0) {
        const importingKey = 'drag-importing-assets'
        // message.loading({ content: '正在导入资产...', key: importingKey, duration: 0 })
        const { default: assetDataAPI } = await import('@renderer/api/assetData')
        for (const f of otherFiles) {
          try {
            const stats = await window.api.getFileStats(f.path)
            const name = f.path.split(/[/\\]/).pop() || f.path
            const fileInfo = {
              name,
              path: f.path,
              type: 'file' as const,
              size: stats?.size ?? null,
              modifiedTime: stats?.mtime ?? new Date().toISOString(),
              depth: 0,
              relativePath: name
            }
            await assetDataAPI.importFolderStructureWithMetadata([fileInfo], 'ALL', 'ALL')
            message.success({ content: t('actionToast.project.assetImported', { path: f.path }) })
          } catch (err: any) {
            message.error({
              content:
                err?.message || t('page.home.project.importToast.assetException', { path: f.path })
            })
          }
        }
        message.destroy(importingKey)
      }
    } finally {
      overlayVisible.value = false
      isDragOver.value = false
      overlayText.value = ''
    }
  }

  return {
    isDragOver,
    overlayVisible,
    overlayText,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    setOnImportComplete
  }
}
