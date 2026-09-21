<script setup lang="ts">
/**
 * 关于页面组件
 * 原型风格：居中布局 + Logo图片 + 下划线链接
 */
import { computed, ref, onMounted, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { message } from '@renderer/utils/messageManager'
import { confirmDialog } from '@renderer/utils/dialog'
import AppButton from '@renderer/components/AppButton.vue'
import BrandMark from '@renderer/components/BrandMark.vue'
import { formatUpdateVersion, useUpdateStore } from '@renderer/store/modules/updateStore'
import { useUpdateInstall } from '@renderer/composables/useUpdateInstall'

const { t } = useI18n()

/**
 * 应用版本号（从 Electron 获取）
 */
const appVersion = ref<string>('...')

/**
 * 更新状态来自全局 Store（store/modules/updateStore.ts）。
 *
 * 这个面板以前自己挂一整套 updater 监听，于是「有没有新版本」这件事只在它
 * 挂载期间成立 —— 关掉设置页，启动时查到的结果就没人记得了。现在监听在
 * App.vue 注册一次，这里只读状态、只管本页面该有的反馈。
 */
const updateStore = useUpdateStore()
const { phase, latestVersion } = storeToRefs(updateStore)

const isChecking = computed(() => phase.value === 'checking')
const latestVersionLabel = computed(() => formatUpdateVersion(latestVersion.value))

/**
 * 这一轮结果是不是用户在这个页面点出来的。
 *
 * 后台每 4 小时会自动查一次，那种检查不该在设置页弹「已是最新版本」；
 * 只有用户亲手点了「检查更新」，才需要给一个明确的回音。
 */
const awaitingManualResult = ref(false)

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
 * 下载更新。进度显示在标题栏那枚角标上，完成后由 watch 接手弹安装框。
 */
async function downloadUpdate(): Promise<void> {
  message.info(t('profile.about.downloading'))
  // 跑起来之后的错走 update-error 事件，App.vue 统一报；「压根没开始」是 Store
  // 自己判出来的，没有事件会推过来，只能在这儿报（同 TabsHeader.startDownload）
  const result = await updateStore.download()
  if (result.success) return
  message.error(result.errorKey ? t(result.errorKey) : result.error || t('update.unavailable'))
}

// 安装确认框和失败提示都走 useUpdateInstall：标题栏角标用的是同一份。
// 原来这两处各写一遍，文案键也各一套，已经跑偏成「关于页报错、角标不报」
const { confirmInstall } = useUpdateInstall()

/**
 * 跟着全局状态走：用户手点的那一轮给回音，下载完成不论来源都要问一句装不装。
 */
watch(phase, (next, previous) => {
  if (next === 'downloaded' && previous !== 'downloaded') {
    awaitingManualResult.value = false
    confirmInstall()
    return
  }

  if (!awaitingManualResult.value) return

  if (next === 'available') {
    awaitingManualResult.value = false
    showUpdateAvailableDialog(latestVersionLabel.value)
  }
})

/**
 * 获取应用版本号
 */
onMounted(async () => {
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

  // 已经有结果在手上就别再发请求：直接把对应的弹窗给出来
  if (phase.value === 'downloaded') {
    confirmInstall()
    return
  }
  if (phase.value === 'available') {
    showUpdateAvailableDialog(latestVersionLabel.value)
    return
  }
  if (phase.value === 'downloading') {
    message.info(t('profile.about.downloading'))
    return
  }

  awaitingManualResult.value = true
  message.info(t('profile.about.checking'))

  // 回音按 check() 返回的结论给，不要去读 watch 到的 phase：watch 默认是
  // flush 'pre'，它那一轮比这里的 await 续体先跑，那时 awaitingManualResult
  // 还是 true、lastError 还没写，于是一次失败的检查会先报「已是最新版本」
  // 再报错，同一次点击弹两条互相矛盾的提示
  const result = await updateStore.check()
  awaitingManualResult.value = false

  if (!result.success) {
    // errorKey 是 api 层造的可翻译失败（桥不在等），优先翻它；
    // error 是主进程原文，没有就退回本页的兜底文案
    message.error(
      result.errorKey ? t(result.errorKey) : result.error || t('profile.about.updateError')
    )
    return
  }
  if (result.outcome === 'upToDate') {
    message.success(t('profile.about.upToDate'))
    return
  }
  // unknown = 这一轮压根没问出结果（没配更新源、已有检查在跑）。不能谎报
  // 「已是最新版本」，但也不能就这么沉默：社区版默认就没有更新源
  // （autoUpdater 的 isConfigured 那一支），那是**最常走的一条路** ——
  // 点一下只看到「正在检查更新...」然后再无下文，这个按钮读起来就是坏的
  if (result.outcome === 'unknown') {
    message.info(t('update.checkUnavailable'))
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
