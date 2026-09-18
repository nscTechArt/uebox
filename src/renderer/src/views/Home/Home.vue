<template>
  <div
    class="home-page"
    @dragenter="handleDragEnter"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDropRefresh"
  >
    <!-- 广告招商 ~ -->
    <!-- <section class="section tools-section">
      <header v-if="false" class="section-header">
        <h2 class="section-title">{{ $t('page.home.toolsSection.title') }}</h2>
        <span class="section-sub">{{ $t('page.home.toolsSection.subtitle') }}</span>
      </header>
      <div class="header-banner">
        <img
          src="@renderer/assets/imgs/header-image.png"
          alt="Unreal Engine Banner"
          class="header-banner__image"
        />
      </div>
    </section> -->

    <!-- 引擎版本 -->
    <EngineSection @engine-drag-enter="handleEngineDragEnter" />

    <!-- 我的工程 -->
    <ProjectSection ref="projectSectionRef" />

    <!-- 拖拽导入覆盖层（仅覆盖工程区域，不遮挡引擎版本） -->
    <div v-if="isDragOver" ref="dragOverlayRef" class="home-drag-overlay" :style="dragOverlayStyle">
      <DragDropOverlay
        :visible="isDragOver"
        :title="overlayText || $t('page.home.project.dropHint')"
        :desc="$t('page.home.project.dropHintDesc')"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch, createApp } from 'vue'
import { useI18n } from 'vue-i18n'
import { notifyPluginInstallFailure } from '@renderer/hooks/usePluginInstallNotice'
import Antd from 'ant-design-vue'
import { message } from '@/utils/messageManager'
import DragDropOverlay from '@renderer/components/DragDropOverlay.vue'
import ProjectSelectModal from '@renderer/components/ProjectSelectModal.vue'
import i18n from '@renderer/i18n'
import { useDragImport } from '@renderer/hooks/useDragImport'
import ProjectSection from './components/Project/ProjectSection.vue'
import EngineSection from './components/EngineSection.vue'

const { t } = useI18n()

const {
  isDragOver,
  overlayText,
  handleDragEnter,
  handleDragOver,
  handleDragLeave,
  setOnImportComplete
} = useDragImport()

/**
 * 当进入引擎区域拖拽时，隐藏项目区域的覆层
 */
const handleEngineDragEnter = (): void => {
  isDragOver.value = false
}

const projectSectionRef = ref<{
  reload: () => Promise<void>
} | null>(null)
const dragOverlayRef = ref<HTMLElement | null>(null)
const projectSectionTop = ref(400) // 默认值，会在 mounted 时更新

// 计算覆层样式：只覆盖工程区域
const dragOverlayStyle = computed(() => ({
  top: `${projectSectionTop.value}px`
}))

// 更新工程区域的位置
const updateProjectSectionPosition = (): void => {
  nextTick(() => {
    const projectSection = document.querySelector('.project-section') as HTMLElement
    if (projectSection) {
      const rect = projectSection.getBoundingClientRect()
      const homePage = document.querySelector('.home-page') as HTMLElement
      if (homePage) {
        const homeRect = homePage.getBoundingClientRect()
        // 覆层完全对齐工程区域顶部
        projectSectionTop.value = Math.max(0, rect.top - homeRect.top)
      }
    }
  })
}

onMounted(async () => {
  updateProjectSectionPosition()
  // 监听窗口大小变化和滚动，更新位置
  window.addEventListener('resize', updateProjectSectionPosition)
  // 拖拽时也更新位置
  watch(isDragOver, () => {
    if (isDragOver.value) {
      updateProjectSectionPosition()
    }
  })
})

// 设置导入完成后的刷新回调
setOnImportComplete(async () => {
  await projectSectionRef.value?.reload()
})

// Home 页面只接受工程和引擎，不导入普通资产
const handleDropRefresh = async (e: DragEvent): Promise<void> => {
  // 应用内部的卡片拖拽（拖工程进分组）也会冒泡到这里，它的 drop 归各自的放置目标管
  if (!e.dataTransfer?.types?.includes('Files')) return
  e.preventDefault()
  e.stopPropagation()

  try {
    const entries = await getDroppedEntries(e)
    if (entries.length === 0) {
      return
    }

    const files = entries.filter((it) => it.isFile)
    const directories = entries.filter((it) => it.isDirectory)
    const uprojectFiles = files.filter((f) => /\.uproject$/i.test(f.path))
    const otherFiles = files.filter((f) => !/\.uproject$/i.test(f.path))

    // 只处理 .uproject 文件和目录（扫描工程）
    // 其他文件不处理（引擎拖拽由 EngineSection 处理）
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
              content: res?.error || t('page.home.project.importToast.fileFailed', { path: f.path })
            })
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          message.error({ content: t('page.home.project.importToast.fileError', { reason: msg }) })
        }
      }
      // 通知外部刷新列表
      if (projectSectionRef.value) {
        await projectSectionRef.value.reload()
      }
    }

    // 处理目录（扫描并导入包含的 .uproject）
    for (const d of directories) {
      try {
        const scanRes = await window.api.database.project.scanDirectory(d.path)
        if (!scanRes?.success) {
          message.error({
            content:
              scanRes?.error || t('page.home.project.importToast.scanFailed', { path: d.path })
          })
          continue
        }

        const foundProjects = scanRes.data || []
        if (foundProjects.length === 0) {
          message.warning({
            content: t('page.home.project.importToast.noUproject', { path: d.path })
          })
          continue
        }

        // 如果只有一个工程，直接导入
        if (foundProjects.length === 1) {
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
            if (projectSectionRef.value) {
              await projectSectionRef.value.reload()
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            message.error({ content: t('page.home.project.importToast.dirError', { reason: msg }) })
          }
          continue
        }

        // 多个工程的情况，弹出选择框让用户勾选要导入的工程
        const projectList = foundProjects.map((filePath: string) => {
          const pathParts = filePath.split(/[\\/]/)
          return {
            filePath,
            name: pathParts[pathParts.length - 1] || filePath
          }
        })

        await new Promise<void>((resolve) => {
          // 创建一个容器元素来挂载组件
          const container = document.createElement('div')
          document.body.appendChild(container)

          // 标记是否已清理，防止重复清理
          let isCleaned = false

          // 清理函数
          const cleanup = (): void => {
            if (isCleaned) return
            isCleaned = true
            try {
              app.unmount()
            } catch (err) {
              console.warn('卸载应用时出错:', err)
            }
            try {
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
                      } else {
                        failCount++
                      }
                    }
                  } catch {
                    failCount++
                  }
                }

                // 生成结果消息
                const parts: string[] = []
                if (successCount > 0)
                  parts.push(t('page.home.project.importToast.summaryOk', { count: successCount }))
                if (skipCount > 0)
                  parts.push(
                    t('page.home.project.importToast.summarySkipped', { count: skipCount })
                  )
                if (failCount > 0)
                  parts.push(t('page.home.project.importToast.summaryFailed', { count: failCount }))

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

                cleanup()
                if (projectSectionRef.value) {
                  await projectSectionRef.value.reload()
                }
                resolve()
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err)
                message.error({
                  content: t('page.home.project.importToast.dirError', { reason: msg })
                })
                cleanup()
                if (projectSectionRef.value) {
                  try {
                    await projectSectionRef.value.reload()
                  } catch {
                    // 刷新失败时静默忽略
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

          // 同上：新 app 实例没有 i18n，ProjectSelectModal / AppModal 会抛
          app.use(i18n)
          app.use(Antd)
          app.mount(container)
        })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        message.error({ content: t('page.home.project.importToast.dirError', { reason: msg }) })
      }
    }

    // 如果有其他文件（非 .uproject），提示不支持
    if (otherFiles.length > 0) {
      message.warning({
        content: t('page.home.project.importToast.nothingFound')
      })
    }
  } finally {
    // 重置拖拽状态
    if (isDragOver.value) {
      isDragOver.value = false
    }
  }
}

// 辅助函数：获取拖拽条目
async function getDroppedEntries(event: DragEvent): Promise<
  Array<{
    path: string
    isFile: boolean
    isDirectory: boolean
  }>
> {
  const entries: Array<{ path: string; isFile: boolean; isDirectory: boolean }> = []
  const files = Array.from(event.dataTransfer?.files || [])

  for (const file of files) {
    try {
      const p = window.api.getPathForFile(file) || (file as { path?: string }).path || ''
      if (!p) continue
      const stats = await window.api.getFileStats(p)
      entries.push({
        path: p,
        isFile: Boolean(stats?.isFile),
        isDirectory: Boolean(stats?.isDirectory)
      })
    } catch (err) {
      console.error('获取拖拽文件路径或状态失败:', err)
    }
  }

  return entries
}

// Markdown 编辑器演示已暂时下线，保留模板注释以便未来恢复
</script>

<style lang="less" scoped>
.home-page {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  gap: var(--space-4);
  overflow-x: hidden;
  position: relative;
  overflow-y: overlay; /* 防止滚动条出现导致的布局抖动 */
  padding-bottom: 40px; /* 增加底部空间，容纳动画位移 */

  .section {
    border-radius: var(--radius-sm);
    background: var(--color-bg-surface);
    padding: var(--section-padding, var(--space-7));

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;

      .section-title {
        margin: 0;
        font-size: var(--font-size-lg);
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
      }

      .section-sub {
        color: var(--color-text-muted);
        font-size: var(--font-size-sm);
      }

      .section-actions {
        display: flex;
        align-items: center;
        gap: var(--space-3);
      }
    }
  }

  .tools-section {
    padding: 28px 28px 0;

    .header-banner {
      width: 100%;
      border-radius: var(--radius-xl);
      overflow: hidden;

      &__image {
        width: 100%;
        height: 180px;
        display: block;
        object-fit: cover;
      }
    }
  }

  .markdown-section {
    .markdown-demo-container {
      height: 600px;
      margin-top: 16px;
    }
  }

  /* 拖拽覆层：只覆盖工程区域，不遮挡引擎版本 */
  .home-drag-overlay {
    position: absolute;
    /* top 值由 dragOverlayStyle 动态计算 */
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
    z-index: 100;

    /* 确保拖拽覆层组件正常显示 */
    :deep(.drag-overlay) {
      z-index: 101;
    }
  }
}
</style>
