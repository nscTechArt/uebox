<script setup lang="ts">
// App组件 - 只作为路由的容器
import { onMounted, ref, computed, onUnmounted } from 'vue'
import { useRoute } from 'vue-router'
import { ConfigProvider } from 'ant-design-vue'

import { useTheme } from '@renderer/hooks/useTheme'
import { useSpotlightAction } from '@renderer/hooks/useSpotlightAction'
import { useLocalShortcuts } from '@renderer/hooks/useLocalShortcuts'
import {
  formatUpdateVersion,
  useUpdateStore,
  type UpdateErrorPayload
} from '@renderer/store/modules/updateStore'
import { message } from '@renderer/utils/messageManager'
import { useI18n } from '@renderer/hooks/useI18n'
// 导入样式系统。调色板必须在最前面 —— 后面每个文件都在引用它定义的语义变量。
import '@renderer/assets/styles/palette.generated.css'
import '@renderer/assets/styles/theme.css'
import '@renderer/assets/styles/typography.css'
import '@renderer/assets/styles/components.css'
import '@renderer/assets/styles/glass-morphism.css'
// import '@renderer/assets/styles/motion.css'
import '@renderer/assets/styles/layout.css'

const route = useRoute()
const { themeConfig, initTheme } = useTheme()
const isWin11 = ref(true)

// 价格 Store

// Spotlight 操作处理
const { init: initSpotlightAction, destroy: destroySpotlightAction } = useSpotlightAction()

// 本地快捷键处理
const { init: initLocalShortcuts, destroy: destroyLocalShortcuts } = useLocalShortcuts()

/**
 * 更新提示。
 *
 * 监听必须挂在这里而不是某个页面里：主进程启动时就静默查一次、之后每 4 小时再查一次，
 * 而 `updater:update-available` 是 `webContents.send` —— 那一刻没人听就是丢了。
 * 以前只有「设置 → 关于」在监听，等于自动检查查到了也没人知道。
 */
const { t } = useI18n()
const updateStore = useUpdateStore()

/** 把 updater 的错误码翻成人话。主进程只在用户主动触发时才推错误，后台静默检查不打扰 */
function resolveUpdateErrorMessage(data?: UpdateErrorPayload): string {
  if (data?.code === 'UPDATE_FEED_NOT_FOUND') return t('profile.about.updateFeedNotReady')
  if (data?.code === 'UPDATE_NETWORK_ERROR') return t('profile.about.updateServerUnavailable')
  return data?.message || t('profile.about.updateError')
}

// 截图模式状态（仅用于显示 UI 确认界面）
const screenshotMode = ref(false)

const isStandaloneWindow = computed(() => {
  return Boolean(route.meta?.standalone)
})

/**
 * 拉取系统信息以决定是否启用背景图（非 Win11）
 */
async function fetchSystemInfo(): Promise<void> {
  try {
    const info = await window.api.system.getInfo()
    isWin11.value = Boolean(info?.isWindows11)
  } catch {
    isWin11.value = true
  }
}

// 截图模式事件监听清理函数
let cleanupScreenshotListener: (() => void) | null = null
let cleanupScreenshotShortcutListener: (() => void) | null = null

// 初始化主题和价格
onMounted(async () => {
  initTheme()

  // 添加主进程日志监听器（用于调试）
  window.api.on('main-log', (...args: unknown[]) => {
    console.log('[主进程]', String(args[0] || ''))
  })

  // 监听截图模式变化
  cleanupScreenshotListener = window.api.screenshot.onModeChanged((data) => {
    screenshotMode.value = data.active
  })

  // 监听快捷键触发进入截图模式
  cleanupScreenshotShortcutListener = window.api.screenshot.onEnterViaShortcut(async () => {
    console.log('[App] 收到快捷键触发截图模式')
    await window.api.screenshot.enterMode()
  })

  // 独立窗口不需要初始化这些
  if (isStandaloneWindow.value) return

  await fetchSystemInfo()

  // 初始化 Spotlight 操作监听
  initSpotlightAction()

  // 初始化本地快捷键监听
  initLocalShortcuts()

  // 发现新版本时弹一次轻提示；常驻入口是标题栏那枚角标
  updateStore.init({
    onAvailable: (version) => {
      message.info({
        content: t('update.foundToast', { version: formatUpdateVersion(version) }),
        duration: 8
      })
    },
    // 错误只在这里报一次，下游（标题栏角标、关于页）不要再各报一遍
    onError: (error) => {
      message.error(resolveUpdateErrorMessage(error))
    }
  })
})

onUnmounted(() => {
  cleanupScreenshotListener?.()
  cleanupScreenshotShortcutListener?.()
  if (!isStandaloneWindow.value) {
    destroySpotlightAction()
    destroyLocalShortcuts()
  }
})
</script>

<template>
  <ConfigProvider :theme="themeConfig">
    <!-- 独立窗口：完全透明，不使用主布局 -->
    <template v-if="isStandaloneWindow">
      <router-view />
    </template>
    <!-- 普通窗口：使用主布局 -->
    <template v-else>
      <div class="app-container">
        <div class="app-content glass">
          <router-view />
        </div>
      </div>
    </template>
  </ConfigProvider>
</template>

<style>
@import './assets/styles/global.css';

.welcome-modal-content p {
  margin-bottom: 12px;
  line-height: 1.6;
}

/* 应用根容器 - 渐变背景 */
.app-container {
  height: 100vh;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  color: var(--color-text-primary);
  font-family: var(--font-family-base);
  box-sizing: border-box;
}

.app-content {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
  transition: all var(--motion-normal) var(--easing-standard);
}

/* 全局滚动条样式 */
* {
  scrollbar-width: thin;
  scrollbar-color: var(--color-border) transparent;
}

*::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

*::-webkit-scrollbar-track {
  background: transparent;
}

*::-webkit-scrollbar-thumb {
  background: var(--color-bg-surface-hover);
  border-radius: 3px;
}

*::-webkit-scrollbar-thumb:hover {
  background: var(--color-bg-surface-hover);
}
</style>
