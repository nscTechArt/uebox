<script setup lang="ts">
/**
 * 关于页面组件
 * 原型风格：居中布局 + Logo图片 + 下划线链接
 */
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@renderer/utils/messageManager'
import { confirmDialog } from '@renderer/utils/dialog'
import AppButton from '@renderer/components/AppButton.vue'
import BrandMark from '@renderer/components/BrandMark.vue'

const { t } = useI18n()

/**
 * 应用版本号（从 Electron 获取）
 */
const appVersion = ref<string>('...')

/**
 * 更新状态
 */
const isChecking = ref(false)
const updateAvailable = ref(false)
const updateDownloaded = ref(false)
const latestVersion = ref<string>('')

// 事件监听器清理函数
const cleanupFunctions: Array<() => void> = []

type UpdateErrorData = {
  message?: string
  code?: string
}

function resolveUpdateErrorMessage(data?: UpdateErrorData): string {
  if (data?.code === 'UPDATE_FEED_NOT_FOUND') {
    return t('profile.about.updateFeedNotReady')
  }

  if (data?.code === 'UPDATE_NETWORK_ERROR') {
    return t('profile.about.updateServerUnavailable')
  }

  return data?.message || t('profile.about.updateError')
}

/**
 * 设置更新事件监听
 */
function setupUpdateListeners(): void {
  // 监听检查中
  cleanupFunctions.push(
    window.api.updater.onUpdateChecking(() => {
      isChecking.value = true
    })
  )

  // 监听发现新版本
  cleanupFunctions.push(
    window.api.updater.onUpdateAvailable((data) => {
      isChecking.value = false
      updateAvailable.value = true
      latestVersion.value = data.version
      showUpdateAvailableDialog(data.version)
    })
  )

  // 监听无更新
  cleanupFunctions.push(
    window.api.updater.onUpdateNotAvailable(() => {
      isChecking.value = false
      updateAvailable.value = false
      message.success(t('profile.about.upToDate'))
    })
  )

  // 监听下载完成
  cleanupFunctions.push(
    window.api.updater.onUpdateDownloaded((data) => {
      isChecking.value = false
      updateDownloaded.value = true
      latestVersion.value = data.version
      showUpdateReadyDialog(data.version)
    })
  )

  // 监听错误
  cleanupFunctions.push(
    window.api.updater.onUpdateError((data) => {
      isChecking.value = false
      message.error(resolveUpdateErrorMessage(data))
    })
  )
}

/**
 * 清理事件监听
 */
function cleanupListeners(): void {
  cleanupFunctions.forEach((cleanup) => cleanup())
  cleanupFunctions.length = 0
}

/**
 * 显示发现新版本对话框。
 *
 * 必须是确认框而不是提示框：安装包几百 MB，下载由用户点了才开始
 * （主进程的 autoDownload 是关的）。以前这里是个 infoDialog，确认键写着
 * 「正在下载更新...」却什么也不做 —— 文案在说谎，下载永远不会发生。
 */
function showUpdateAvailableDialog(version: string): void {
  confirmDialog({
    title: t('profile.about.checkUpdate'),
    content: t('profile.about.updateAvailable', { version }),
    okText: t('profile.about.downloadNow'),
    cancelText: t('profile.about.later'),
    onOk: () => {
      // 故意不返回 Promise：返回了弹窗就会顶着 loading 等下载走完，
      // 而这是几百 MB。让它立刻关掉，进度和结果交给事件
      void downloadUpdate()
    }
  })
}

/**
 * 下载更新。下载完成由 onUpdateDownloaded 接手弹安装框。
 */
async function downloadUpdate(): Promise<void> {
  // 先提示再 await —— downloadUpdate() 要等整个下载结束才 resolve，
  // 放在后面的话「正在下载」会在下载完成之后才弹出来
  message.info(t('profile.about.downloading'))

  try {
    const result = await window.api.updater.downloadUpdate()
    if (!result.success) {
      message.error(result.error || t('profile.about.downloadError'))
    }
  } catch (e) {
    console.error('下载更新失败:', e)
    message.error(t('profile.about.downloadError'))
  }
}

/**
 * 显示更新就绪对话框
 */
function showUpdateReadyDialog(version: string): void {
  confirmDialog({
    title: t('profile.about.checkUpdate'),
    content: t('profile.about.updateReady', { version }),
    okText: t('profile.about.installNow'),
    cancelText: t('profile.about.later'),
    onOk: () => {
      installUpdate()
    }
  })
}

/**
 * 安装更新
 */
async function installUpdate(): Promise<void> {
  try {
    // IPC 失败是返回 { success: false }，不是抛异常 —— 只 catch 的话装不上也悄无声息
    const result = await window.api.updater.quitAndInstall()
    if (!result.success) {
      message.error(result.error || t('profile.about.updateError'))
    }
  } catch (e) {
    console.error('安装更新失败:', e)
    message.error(t('profile.about.updateError'))
  }
}

/**
 * 获取应用版本号
 */
onMounted(async () => {
  // 设置更新事件监听
  setupUpdateListeners()

  try {
    const info = await window.api.system.getInfo()
    if (info?.appVersion) {
      appVersion.value = info.appVersion
    }
  } catch (e) {
    console.error('获取应用版本失败:', e)
    appVersion.value = 'unknown'
  }
})

onUnmounted(() => {
  cleanupListeners()
})

/**
 * 打开外部链接
 */
function openLink(url: string): void {
  window.open(url, '_blank')
}

/**
 * 检查更新
 */
async function checkForUpdates(): Promise<void> {
  if (isChecking.value) return

  isChecking.value = true
  message.info(t('profile.about.checking'))

  try {
    await window.api.updater.checkForUpdates()
  } catch (e) {
    isChecking.value = false
    console.error('检查更新失败:', e)
    message.error(t('profile.about.updateError'))
  }
}
</script>

<template>
  <div class="about-content">
    <!-- Logo 区域 -->
    <div class="logo-wrapper">
      <div class="logo-container">
        <BrandMark class="logo-img" />
      </div>
    </div>

    <!-- 应用信息 -->
    <div class="app-info">
      <h3 class="app-name">UNREAL BOX</h3>
      <p class="app-version">{{ $t('profile.about.version') }} {{ appVersion }}</p>
    </div>

    <!-- 描述文字 -->
    <div class="app-description">
      {{ $t('profile.about.description') }}<br />
      <span class="heart-icon" aria-hidden="true">❤</span>
      <span>{{ $t('profile.about.contributors') }}</span>
    </div>

    <!-- 底部链接 -->
    <div class="about-links">
      <AppButton variant="soft" size="medium" @click="checkForUpdates">
        {{ $t('profile.about.checkUpdate') }}
      </AppButton>
      <!--
        原来这里挂的是一块内部 Trello 看板。开源版不该把团队的内部计划板
        当成用户入口 —— 换成开源许可，那才是这个版本里用户真正需要知道的事。
      -->
      <AppButton variant="soft" size="medium" @click="openLink('https://github.com/ueboxai')">
        GitHub
      </AppButton>
      <AppButton
        variant="soft"
        size="medium"
        @click="openLink('https://www.apache.org/licenses/LICENSE-2.0')"
      >
        Apache-2.0
      </AppButton>
    </div>
  </div>
</template>

<style scoped lang="less">
.about-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--space-10) 0;
  gap: var(--space-6);
}

/* Logo 区域 */
.logo-wrapper {
  margin-bottom: var(--space-4);
}

.logo-container {
  width: 80px;
  height: 80px;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.logo-img {
  width: 100%;
  height: 100%;
}

/* 应用信息 */
.app-info {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.app-name {
  margin: 0;
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  letter-spacing: 0.02em;
}

.app-version {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-family: monospace;
}

/* 描述文字 */
.app-description {
  max-width: 320px;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.heart-icon {
  color: var(--color-danger-text);
}

/* 底部链接 */
.about-links {
  padding-top: var(--space-6);
  display: flex;
  justify-content: center;
  gap: var(--space-4);
}
</style>
