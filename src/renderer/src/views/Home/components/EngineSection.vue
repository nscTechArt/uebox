<template>
  <section
    class="section engine-section"
    @dragenter.stop.prevent="handleDragEnter"
    @dragover.stop.prevent="handleDragOver"
    @dragleave.stop.prevent="handleDragLeave"
    @drop.stop.prevent="handleDropAddEngine"
  >
    <header class="section-header">
      <div class="flex items-center gap-3">
        <h2 class="section-title">{{ t('page.home.engine.title') }}</h2>
        <AppButton @click="handleClickAddEngine">
          <template #icon><PhPlus /></template>
        </AppButton>
        <AppButton
          :loading="isRefreshingEngines"
          :title="t('page.home.engine.refresh')"
          @click="handleRefreshEngines"
        >
          <template #icon><PhArrowClockwise /></template>
        </AppButton>
        <!--
          列表还在、但这趟没读到：显示的是上一次的结果。不说出来的话，用户看到
          一个已经卸载的引擎还挂在那里，点启动才发现路径没了，报错还怪到引擎头上。
          空列表的情况由下面的 AppEmpty 说，这里只管「有内容但是旧的」。
        -->
        <AppTag v-if="scanFailed && engines.length > 0" tone="danger">
          {{ t('page.home.engine.staleList') }}
        </AppTag>
      </div>
    </header>
    <div class="engine-list">
      <div
        v-for="engine in engines"
        :key="engine.version"
        class="engine-card"
        :class="{
          'is-running': runningVersion === engine.version,
          'is-default': defaultVersion === engine.version
        }"
        @dblclick="() => onCardDblClick(engine)"
      >
        <div class="card-header">
          <div class="version">{{ engine.version }}</div>
          <div class="status">
            <AppTag v-if="lastOpenedVersion === engine.version" class="status-tag">{{
              t('page.home.engine.lastOpened')
            }}</AppTag>
            <PhStar
              v-if="defaultVersion === engine.version"
              weight="fill"
              class="star-icon"
              :aria-label="t('page.home.engine.default')"
            />
          </div>
        </div>

        <div class="divider">
          <div
            class="divider-track"
            :style="{ width: `${launchProgress[engine.version] ?? 0}%` }"
          ></div>
        </div>
        <!-- 底部主按钮：启动引擎 -->
        <div class="launch-area">
          <span class="launch-trigger" @click.stop="() => handleEngineStart(engine)" @dblclick.stop>
            {{ t('page.home.engine.start') }}
          </span>
        </div>

        <!-- 右下角更多菜单 -->
        <div class="more-menu">
          <AppDropdown :trigger="['hover']" :overlay-style="{ marginTop: '4px' }">
            <span class="more-icon" @dblclick.stop>
              <PhDotsThree />
            </span>
            <template #overlay>
              <AppMenu>
                <AppMenuItem
                  key="open-root"
                  item-key="open-root"
                  @click="() => handleOpenEnginePath('root', engine)"
                  >{{ t('page.home.engine.openRoot') }}</AppMenuItem
                >
                <AppMenuItem
                  key="open-plugins"
                  item-key="open-plugins"
                  @click="() => handleOpenEnginePath('plugins', engine)"
                  >{{ t('page.home.engine.openPlugins') }}</AppMenuItem
                >
                <AppMenuDivider />
                <AppMenuItem
                  key="set-default"
                  item-key="set-default"
                  @click="() => toggleDefaultVersion(engine.version)"
                  >{{
                    defaultVersion === engine.version
                      ? t('page.home.engine.unsetDefault')
                      : t('page.home.engine.setDefault')
                  }}</AppMenuItem
                >
                <AppMenuDivider />
                <AppMenuItem
                  key="remove"
                  item-key="remove"
                  danger
                  @click="() => handleRemoveEngine(engine)"
                  >{{ t('page.home.engine.remove') }}</AppMenuItem
                >
              </AppMenu>
            </template>
          </AppDropdown>
        </div>
        <div class="logo-wrap">
          <div class="engine-logo"></div>
        </div>
      </div>
    </div>

    <!--
      扫描中 / 一个引擎都没扫到，都得说句话。
      原来这两种情况都是一片空白 —— 新用户分不清是「没装引擎」「还在扫」
      还是「盒子坏了」，而这正好是他第一次打开盒子看到的那一屏。
      空态放在 .engine-list 外面：它不是网格里的一项，不该再拿 CSS 去横跨整行。
    -->
    <AppPageSkeleton v-if="initLoading" variant="engines" :count="10" />
    <AppEmpty
      v-else-if="engines.length === 0"
      :title="scanFailed ? t('page.home.engine.scanFailedTitle') : t('page.home.engine.emptyTitle')"
      :description="
        scanFailed ? t('page.home.engine.scanFailedDesc') : t('page.home.engine.emptyDesc')
      "
    />

    <!-- 仅用于引擎区：拖入自编译/自定义引擎根目录 -->
    <DragDropOverlay
      :visible="isDragOver"
      :title="overlayTitle"
      :desc="t('page.home.engine.dropDesc')"
    />
  </section>
</template>

<script setup lang="ts">
import AppEmpty from '@renderer/components/AppEmpty.vue'
import AppPageSkeleton from '@renderer/components/AppPageSkeleton.vue'
import AppTag from '@renderer/components/AppTag.vue'
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuDivider from '@renderer/components/AppMenuDivider.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { h, ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@/utils/messageManager'
import DragDropOverlay from '@renderer/components/DragDropOverlay.vue'
import { PhArrowClockwise, PhDotsThree, PhPlus, PhStar } from '@phosphor-icons/vue'
import { confirmDialog } from '@renderer/utils/dialog'
import { useEngineList, mapEngineInfoToItem } from './useEngineList'
import type { EngineItem } from './useEngineList'

/**
 * 定义组件事件
 * engine-drag-enter: 当进入引擎区域拖拽时触发，通知父组件隐藏项目覆层
 * engine-drag-leave: 当离开引擎区域拖拽时触发
 */
const emit = defineEmits<{
  (e: 'engine-drag-enter'): void
  (e: 'engine-drag-leave'): void
}>()

type InvalidCustomEngineItem = {
  name: string
  version: string
  rootPath: string
}

const { engines, scanFailed, initLoading, refresh } = useEngineList()
const runningVersion = ref<string | null>(null)
const defaultVersion = ref<string | null>(localStorage.getItem('defaultEngineVersion') || null)
const lastOpenedVersion = ref<string | null>(
  localStorage.getItem('lastOpenedEngineVersion') || null
)
const launchProgress = ref<Record<string, number>>({})
const isRefreshingEngines = ref(false)
const progressRafIds = new Map<string, number>()
const { t } = useI18n()

// 引擎区拖拽态（避免和 Home 页的“工程/资产导入拖拽”冲突）
const isDragOver = ref(false)
const overlayTitle = ref(t('page.home.engine.dropTitle'))

/** Keep selection cleanup tied to a successful background scan. */
const loadEngines = async (): Promise<boolean> => {
  const outcome = await refresh()
  if (outcome.syncSelections) syncEngineSelectionsWithList()
  syncProgressWithLastOpened()
  return outcome.ok
}
/**
 * 同步进度与上次打开版本（进入页面时）
 */
function syncProgressWithLastOpened(): void {
  const last = lastOpenedVersion.value
  if (!last) {
    launchProgress.value = {}
    return
  }
  launchProgress.value[last] = 100
  for (const e of engines.value) {
    if (e.version !== last) {
      delete launchProgress.value[e.version]
    }
  }
}

onMounted(async () => {
  await loadEngines()
})

const renderCleanupPreview = (summary: string, lines: string[], moreText?: string) =>
  h('div', { style: 'display: grid; gap: 8px;' }, [
    h('div', summary),
    ...lines.map((line) =>
      h(
        'div',
        {
          style:
            'font-size: 12px; line-height: 1.5; color: var(--color-text-primary); word-break: break-all;'
        },
        line
      )
    ),
    ...(moreText
      ? [h('div', { style: 'font-size: 12px; color: var(--color-text-muted);' }, moreText)]
      : [])
  ])

const syncEngineSelectionsWithList = (): void => {
  const versions = new Set(engines.value.map((item) => item.version))

  if (defaultVersion.value && !versions.has(defaultVersion.value)) {
    defaultVersion.value = null
    localStorage.removeItem('defaultEngineVersion')
  }

  if (lastOpenedVersion.value && !versions.has(lastOpenedVersion.value)) {
    lastOpenedVersion.value = null
    localStorage.removeItem('lastOpenedEngineVersion')
  }
}

const handleRefreshEngines = async (): Promise<void> => {
  if (isRefreshingEngines.value) return

  isRefreshingEngines.value = true
  try {
    const [inspectRet, scanOk] = await Promise.all([
      window.api.unrealPath.inspectInvalidCustomPaths(),
      loadEngines()
    ])

    const invalidItems: InvalidCustomEngineItem[] = inspectRet?.success ? inspectRet.data || [] : []

    // 扫描失败只吃掉那句绿色的「刷新完成」—— 失效自定义引擎是另一条 IPC 查出来的，
    // 它没失败，用户照样该有机会清掉那几条。全都 return 掉的话，扫描一直降级的机器
    // 上这个清理入口就永远点不到了。
    if (invalidItems.length === 0) {
      if (!scanOk) message.error(t('page.home.engine.scanFailed'))
      else message.success(t('page.home.engine.cleanupNone'))
      return
    }
    if (!scanOk) message.error(t('page.home.engine.scanFailed'))

    const previewLines = invalidItems
      .slice(0, 5)
      .map((item) => `${item.version || item.name || 'Unknown'}  ${item.rootPath}`)
    const moreCount = invalidItems.length - previewLines.length

    confirmDialog({
      title: t('page.home.engine.cleanupConfirmTitle', { count: invalidItems.length }),
      content: renderCleanupPreview(
        t('page.home.engine.cleanupConfirmContent'),
        previewLines,
        moreCount > 0 ? t('page.home.engine.cleanupMore', { count: moreCount }) : undefined
      ),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      centered: true,
      async onOk() {
        const results = await Promise.all(
          invalidItems.map((item) => window.api.unrealPath.removeCustomPath(item.rootPath))
        )
        const removedItems = invalidItems.filter((_, index) => results[index]?.success)
        // 清理结果自己会说话，重扫失败不在这里再叠一句
        await loadEngines()

        if (removedItems.length > 0) {
          message.success(t('page.home.engine.cleanupSuccess', { count: removedItems.length }))
          return
        }

        message.error(t('page.home.engine.cleanupFailed'))
      }
    })
  } catch (error) {
    console.error('[EngineSection] Failed to refresh engines:', error)
    message.error(t('page.home.engine.cleanupFailed'))
  } finally {
    isRefreshingEngines.value = false
  }
}

type DroppedEntry = {
  path: string
  isFile: boolean
  isDirectory: boolean
}

async function getDroppedEntries(event: DragEvent): Promise<DroppedEntry[]> {
  const entries: DroppedEntry[] = []
  const files = Array.from(event.dataTransfer?.files || [])
  for (const file of files) {
    try {
      const fileWithPath = file as unknown as { path?: string }
      const p = window.api.getPathForFile(file) || fileWithPath.path || ''
      if (!p) continue
      const stats = await window.api.getFileStats(p)
      entries.push({
        path: p,
        isFile: Boolean(stats?.isFile),
        isDirectory: Boolean(stats?.isDirectory)
      })
    } catch (err) {
      console.warn('[EngineSection] 获取拖拽路径失败:', err)
    }
  }
  return entries
}

function normalizeEngineRootCandidate(p: string): string {
  if (!p) return ''
  const s = String(p).trim()
  // 1) 拖入的是 Editor 可执行文件
  // ...\Engine\Binaries\Win64\UnrealEditor.exe  -> root
  // ...\Binaries\Win64\UE4Editor.exe          -> root
  const reEngineExe = /[\\/](Engine)[\\/](Binaries)[\\/](Win64)[\\/](UnrealEditor|UE4Editor)\.exe$/i
  if (reEngineExe.test(s)) {
    return s.replace(reEngineExe, '')
  }
  const reExe = /[\\/](Binaries)[\\/](Win64)[\\/](UnrealEditor|UE4Editor)\.exe$/i
  if (reExe.test(s)) {
    return s.replace(reExe, '')
  }
  // 2) 拖入的是 Engine 目录本身 -> root = parent
  const reEngineDir = /[\\/]Engine$/i
  if (reEngineDir.test(s)) {
    return s.replace(reEngineDir, '')
  }
  // 3) 默认认为就是引擎 root
  return s
}

/**
 * 引擎区域拖拽进入事件
 * 阻止冒泡以避免触发Home.vue的项目区域覆层
 */
const handleDragEnter = (e: DragEvent): void => {
  e.stopPropagation() // 阻止冒泡到Home.vue
  emit('engine-drag-enter') // 通知父组件隐藏项目覆层
  if (e.dataTransfer?.types.includes('Files')) {
    isDragOver.value = true
    const count = e.dataTransfer.items?.length || e.dataTransfer.files?.length || 0
    overlayTitle.value =
      count > 0 ? `${t('page.home.engine.dropTitle')} (${count})` : t('page.home.engine.dropTitle')
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }
}

/**
 * 引擎区域拖拽悬停事件
 * 阻止冒泡以避免触发Home.vue的项目区域覆层
 */
const handleDragOver = (e: DragEvent): void => {
  e.stopPropagation() // 阻止冒泡到Home.vue
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}

/**
 * 引擎区域拖拽离开事件
 */
const handleDragLeave = (e: DragEvent): void => {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const x = e.clientX
  const y = e.clientY
  if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
    return
  }
  isDragOver.value = false
}

const handleDropAddEngine = async (e: DragEvent): Promise<void> => {
  try {
    const entries = await getDroppedEntries(e)
    if (entries.length === 0) return

    // 允许拖入：引擎根目录 / Engine 目录 / UnrealEditor.exe
    const candidates = Array.from(
      new Set(entries.map((it) => normalizeEngineRootCandidate(it.path)).filter(Boolean))
    )

    let addedCount = 0
    let failedCount = 0
    for (const root of candidates) {
      const add = await window.api.unrealPath.addCustomPath(root)
      const info = add?.data
      if (add?.success && info) {
        const item = {
          ...mapEngineInfoToItem(info),
          channel: 'Custom'
        }
        const existIndex = engines.value.findIndex((x) => x.version === item.version)
        if (existIndex >= 0) {
          engines.value.splice(existIndex, 1, item)
        } else {
          engines.value.push(item)
        }
        addedCount++
      } else {
        failedCount++
      }
    }

    if (addedCount > 0) {
      message.success(t('page.home.engine.addSuccess', { count: addedCount }))
    }
    if (addedCount === 0 && failedCount > 0) {
      message.error(t('page.home.engine.notValidRoot'))
    }
  } finally {
    isDragOver.value = false
  }
}

/**
 * 点击添加按钮后弹出目录选择对话框，添加用户选择的引擎目录
 * 处理逻辑与拖入目录一致
 */
const handleClickAddEngine = async (): Promise<void> => {
  try {
    // 弹出目录选择对话框
    const result = await window.api.dialog.showOpenDialog({
      title: t('page.home.engine.selectEngineDir'),
      properties: ['openDirectory']
    })

    // 用户取消选择
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return
    }

    const selectedPath = result.filePaths[0]
    // 使用与拖拽相同的归一化逻辑
    const root = normalizeEngineRootCandidate(selectedPath)

    if (!root) {
      message.error(t('page.home.engine.notValidRoot'))
      return
    }

    // 调用添加引擎的 API
    const add = await window.api.unrealPath.addCustomPath(root)
    const info = add?.data

    if (add?.success && info) {
      const item = {
        ...mapEngineInfoToItem(info),
        channel: 'Custom'
      }
      const existIndex = engines.value.findIndex((x) => x.version === item.version)
      if (existIndex >= 0) {
        engines.value.splice(existIndex, 1, item)
      } else {
        engines.value.push(item)
      }
      message.success(t('page.home.engine.addSuccess', { count: 1 }))
    } else {
      message.error(t('page.home.engine.notValidRoot'))
    }
  } catch (err) {
    console.error('[EngineSection] 添加引擎失败:', err)
    message.error(t('page.home.engine.notValidRoot'))
  }
}

/**
 * 记录上次打开版本（本地存储）
 */
const markLastOpened = (version: string): void => {
  lastOpenedVersion.value = version
  localStorage.setItem('lastOpenedEngineVersion', version)
  launchProgress.value[version] = 100
  for (const e of engines.value) {
    if (e.version !== version) {
      delete launchProgress.value[e.version]
    }
  }
}

/**
 * 启动指定引擎版本
 */
const handleEngineStart = async (engine: EngineItem): Promise<void> => {
  startLaunchProgress(engine.version)
  const res = await window.api.shell.openPath(engine.enginePath)
  if (res?.success) {
    runningVersion.value = engine.version
    message.success(t('page.home.engine.startSuccess', { version: engine.version }))
    completeLaunchProgress(engine.version)
    markLastOpened(engine.version)
    setTimeout(() => {
      runningVersion.value = null
    }, 1200)
  } else {
    message.error(res?.error || t('page.home.engine.startFailed', { version: engine.version }))
    clearLaunchProgress(engine.version)
  }
}

/**
 * 打开引擎目录或插件目录
 */
const handleOpenEnginePath = async (
  type: 'root' | 'plugins',
  engine: EngineItem
): Promise<void> => {
  const targetPath = type === 'root' ? engine.rootPath : engine.pluginPath
  if (!targetPath) {
    message.error(t('page.home.engine.openPathFailed'))
    return
  }

  const res = await window.api.shell.openPath(targetPath)
  if (!res?.success) {
    message.error(res?.error || t('page.home.engine.openPathFailed'))
  }
}

/**
 * 切换默认启动版本（设为默认/取消默认）
 */
const toggleDefaultVersion = (version: string): void => {
  if (defaultVersion.value === version) {
    // 当前是默认版本，取消默认
    defaultVersion.value = null
    localStorage.removeItem('defaultEngineVersion')
    message.success(t('page.home.engine.unsetDefaultSuccess'))
  } else {
    // 设为默认版本
    defaultVersion.value = version
    localStorage.setItem('defaultEngineVersion', version)
    message.success(t('page.home.engine.setDefaultSuccess', { version }))
  }
}

/**
 * 移除引擎
 */
const handleRemoveEngine = async (engine: EngineItem): Promise<void> => {
  // 如果是 Epic Launcher 安装的引擎，提示无法移除
  if (engine.channel === 'Epic Launcher') {
    message.warning(t('page.home.engine.epicManaged'))
    return
  }

  // 自定义引擎：从列表中移除，并从数据库中删除
  const index = engines.value.findIndex(
    (e) => e.version === engine.version && e.rootPath === engine.rootPath
  )
  if (index >= 0) {
    engines.value.splice(index, 1)

    // 从数据库中删除持久化记录
    try {
      await window.api.unrealPath.removeCustomPath(engine.rootPath)
    } catch (err) {
      console.warn('[EngineSection] 从数据库删除引擎记录失败:', err)
    }

    message.success(t('page.home.engine.removeSuccess', { version: engine.version }))

    syncEngineSelectionsWithList()
  }
}

/**
 * 双击卡片启动引擎
 */
const onCardDblClick = (engine: EngineItem): void => {
  handleEngineStart(engine)
}

/**
 * 启动进度：以缓动动画推进到预目标值
 * 使用更长的动画时间让加速过程更自然
 */
const startLaunchProgress = (version: string): void => {
  // 立即初始化进度为 0，确保 UI 立即响应
  launchProgress.value[version] = 0
  // 使用 requestAnimationFrame 确保 DOM 更新后再开始动画
  requestAnimationFrame(() => {
    animateTo(version, 0, 90, 4000)
  })
}

/**
 * 启动进度：完成动画
 */
/**
 * 启动进度：完成阶段，平滑到 100%
 * 使用较长的动画时间，因为引擎启动后还需要加载时间
 */
const completeLaunchProgress = (version: string): void => {
  const cur = launchProgress.value[version] ?? 0
  animateTo(version, cur, 100, 2800)
}

/**
 * 启动进度：清理动画与定时器
 */
/**
 * 启动进度：清理动画与定时器
 */
const clearLaunchProgress = (version: string): void => {
  const id = progressRafIds.get(version)
  if (id) {
    cancelAnimationFrame(id)
    progressRafIds.delete(version)
  }
  window.setTimeout(() => {
    delete launchProgress.value[version]
  }, 300)
}

/**
 * 通用缓动动画：将进度从 from 平滑过渡到 to
 * 使用 easeOutQuart 缓动函数让开始阶段更快，结束更平滑
 */
const animateTo = (version: string, from: number, to: number, duration: number): void => {
  if (progressRafIds.has(version)) {
    const id = progressRafIds.get(version)!
    cancelAnimationFrame(id)
    progressRafIds.delete(version)
  }

  const start = performance.now()
  // 使用 easeOutQuart 缓动：开始快，结束慢，更自然
  const easeOutQuart = (t: number): number => 1 - Math.pow(1 - t, 4)

  const tick = (now: number): void => {
    const elapsed = now - start
    const t = Math.min(elapsed / duration, 1)
    const v = from + (to - from) * easeOutQuart(t)
    launchProgress.value[version] = Math.max(0, Math.min(100, v))

    if (t < 1) {
      const id = requestAnimationFrame(tick)
      progressRafIds.set(version, id)
    } else {
      progressRafIds.delete(version)
    }
  }

  const id = requestAnimationFrame(tick)
  progressRafIds.set(version, id)
}
</script>

<style lang="less" scoped>
.engine-section {
  position: relative;

  .engine-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 16px;
    margin-top: 16px;
  }
}

.engine-card {
  position: relative;
  width: 100%;
  min-width: 220px;
  max-width: 240px;
  height: 132px;
  padding: 16px;
  border-radius: 16px;
  background: linear-gradient(135deg, transparent, var(--color-bg-surface));
  border: 1px solid var(--color-border-subtle);
  backdrop-filter: blur(18px) saturate(150%);
  -webkit-backdrop-filter: blur(18px) saturate(150%);
  box-shadow: 0 6px 30px var(--shadow-color-strong);
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease,
    border-color 0.2s ease;
  overflow: hidden;
  cursor: pointer;
}

.engine-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 16px 35px var(--shadow-color-strong);
  border-color: var(--color-border);
}

.engine-card::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 16px;
  background:
    radial-gradient(120px 40px at 30% 0%, rgba(255, 255, 255, 0.06), transparent 60%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 40%);
  pointer-events: none;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 0px;
}

.version {
  font-size: 32px;
  font-weight: 600;
  color: var(--color-text-primary);
}

.status {
  display: flex;
  align-items: center;
  gap: 6px;
}

.status-tag {
  border-radius: 10px;
  font-size: 12px;
  padding: 1px 8px 2px 8px;
  color: var(--color-text-on-solid);
  background: var(--color-accent-solid);
  border: 1px solid var(--color-accent-solid);
}

.star-icon {
  font-size: 14px;
  color: var(--color-warning-text);
}

.logo-wrap {
  position: absolute;
  top: -78px;
  right: -62px;
  width: 190px;
  height: 190px;
  z-index: 0;
  pointer-events: none;
}

.engine-logo {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.engine-logo::after {
  content: '';
  position: absolute;
  inset: 0;
  /* 水印式的引擎徽标。用 mask 而不是 background-image：
     图片是白色字形，浅色主题下压在白底上就没了。 */
  background-color: currentColor;
  -webkit-mask: url('@renderer/assets/icon/ic_unreal_engine.png') center / 70% no-repeat;
  mask: url('@renderer/assets/icon/ic_unreal_engine.png') center / 70% no-repeat;
  opacity: 0.021;
  pointer-events: none;
}

.divider {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 34px;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.02));
  overflow: hidden;
}

.divider-track {
  height: 100%;
  border-radius: 2px;
  background: var(--gradient-accent);
  box-shadow: 0 0 12px var(--color-accent-border);
  /* 不使用 CSS transition，由 JS requestAnimationFrame 控制平滑动画 */
  position: relative;
}

.divider-track::after {
  content: '';
  position: absolute;
  right: -10px;
  top: -4px;
  width: 36px;
  height: 10px;
  border-radius: 12px;
  background: radial-gradient(
    10px 10px at 50% 50%,
    rgba(255, 255, 255, 0.9),
    rgba(255, 255, 255, 0)
  );
  filter: blur(2px);
}

.subtext {
  font-size: 12px;
  color: var(--color-text-primary);
}

.start-btn {
  height: 30px;
  padding: 0 18px;
  color: var(--color-text-primary);
  background-image: var(--gradient-accent);
  border: none;
}

.start-btn:hover {
  filter: brightness(1.05);
}

/* 底部主启动按钮区域 */
.launch-area {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 8px;
  text-align: center;
  z-index: 2;
}

.launch-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 5px 24px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border);
  cursor: pointer;
  transition: all 0.2s ease;
}

.launch-trigger:hover {
  filter: brightness(1.08);
  border-color: var(--color-border-strong);
}

.launch-trigger:active {
  transform: translateY(0);
  box-shadow: 0 1px 4px var(--color-accent-border);
}

/* 右下角更多菜单 */
.more-menu {
  position: absolute;
  right: 10px;
  bottom: 10px;
  z-index: 3;
}

.more-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--color-text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.more-icon:hover {
  color: var(--color-text-primary);
  background: var(--color-bg-surface-hover);
}
</style>
