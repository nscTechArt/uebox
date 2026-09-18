<script setup lang="ts">
/** 常规设置：语言、启动行为与通知。 */
import { ref, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { getLocale, setLocale } from '@renderer/i18n'
import { message } from '@renderer/utils/messageManager'
import AppSwitch from '@renderer/components/AppSwitch.vue'

const { t } = useI18n()

const language = ref<'zh-CN' | 'en-US'>(getLocale() as 'zh-CN' | 'en-US')

/**
 * 同步到主进程的那一步在 `setLocale()` 里面做，这里不用再推一遍。
 *
 * 原来是在这里推的，于是首次启动的语言门（它只调 setLocale）就漏了 —— 新用户
 * 选了 English，第一次会话的托盘和原生对话框仍是中文。挪进 setLocale 之后，
 * 任何调用方都不会再漏。
 */
watch(language, async (newLocale) => {
  setLocale(newLocale)
  message.success(
    t(
      newLocale === 'zh-CN'
        ? 'profile.appearance.languageChangedZh'
        : 'profile.appearance.languageChangedEn'
    )
  )
})

const autoLaunch = ref(true)
/**
 * 通知三项。真相源在主进程（`appSettingsManager`）——判定发生在那边的
 * `services/agentNotifications`，渲染层这份只是给控件做双向绑定用的镜像。
 */
const notifyTurnComplete = ref<'off' | 'unfocused' | 'always'>('unfocused')
const notifyApprovalRequired = ref(true)
const notifyQuestionRequired = ref(true)

// 标记是否正在从 IPC 加载设置（避免初始化时触发保存）
const isLoadingSettings = ref(true)

/**
 * 组件挂载时从主进程加载设置
 */
onMounted(async () => {
  try {
    const settings = await window.api.appSettings.get()
    autoLaunch.value = settings.autoLaunch
    notifyTurnComplete.value = settings.notifyTurnComplete
    notifyApprovalRequired.value = settings.notifyApprovalRequired
    notifyQuestionRequired.value = settings.notifyQuestionRequired
  } catch (error) {
    console.error('加载应用设置失败:', error)
  } finally {
    // 延迟标记加载完成，确保 watch 不会在初始化时触发
    setTimeout(() => {
      isLoadingSettings.value = false
    }, 100)
  }
})

/**
 * 监听开机自启设置变化
 */
watch(autoLaunch, async (newValue) => {
  if (isLoadingSettings.value) return
  try {
    await window.api.appSettings.setAutoLaunch(newValue)
    message.success(
      t(newValue ? 'profile.general.autoLaunchEnabled' : 'profile.general.autoLaunchDisabled')
    )
  } catch (error) {
    console.error('设置开机自启失败:', error)
    message.error(t('profile.general.settingSaveFailed'))
  }
})

/**
 * 通知三项写回主进程。
 *
 * 不弹「已保存」的提示：改的是「什么时候提醒我」，用户下一次真收到（或收不到）
 * 通知就是反馈本身，当场再弹一个气泡属于用通知打断一次关于通知的设置。
 */
watch([notifyTurnComplete, notifyApprovalRequired, notifyQuestionRequired], async () => {
  if (isLoadingSettings.value) return
  try {
    await window.api.appSettings.set({
      notifyTurnComplete: notifyTurnComplete.value,
      notifyApprovalRequired: notifyApprovalRequired.value,
      notifyQuestionRequired: notifyQuestionRequired.value
    })
  } catch (error) {
    console.error('保存通知设置失败:', error)
    message.error(t('profile.general.settingSaveFailed'))
  }
})
</script>

<template>
  <div class="settings-content">
    <section class="settings-section">
      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-label">{{ $t('profile.appearance.language') }}</div>
        </div>
        <a-select
          v-model:value="language"
          class="language-select"
          :aria-label="$t('profile.appearance.language')"
        >
          <a-select-option value="zh-CN">{{
            $t('profile.appearance.languageZhCN')
          }}</a-select-option>
          <a-select-option value="en-US">{{
            $t('profile.appearance.languageEnUS')
          }}</a-select-option>
        </a-select>
      </div>
    </section>
    <!-- 启动行为 Section -->
    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.general.startupBehavior') }}</h4>
      <div class="settings-list">
        <!-- 开机自启动 -->
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.general.autoLaunch') }}</div>
          </div>
          <AppSwitch v-model:checked="autoLaunch" />
        </div>
      </div>
    </section>

    <!-- 通知 Section -->
    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.general.notifications') }}</h4>
      <div class="settings-list">
        <!-- 一轮跑完 -->
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.general.notifyTurnComplete') }}</div>
            <div class="setting-desc">{{ $t('profile.general.notifyTurnCompleteDesc') }}</div>
          </div>
          <a-select v-model:value="notifyTurnComplete" style="width: 160px">
            <a-select-option value="off">
              {{ $t('profile.general.notifyTurnCompleteOff') }}
            </a-select-option>
            <a-select-option value="unfocused">
              {{ $t('profile.general.notifyTurnCompleteUnfocused') }}
            </a-select-option>
            <a-select-option value="always">
              {{ $t('profile.general.notifyTurnCompleteAlways') }}
            </a-select-option>
          </a-select>
        </div>

        <!-- 卡在审批上 -->
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.general.notifyApproval') }}</div>
            <div class="setting-desc">{{ $t('profile.general.notifyApprovalDesc') }}</div>
          </div>
          <AppSwitch v-model:checked="notifyApprovalRequired" />
        </div>

        <!-- 卡在反问上 -->
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.general.notifyQuestion') }}</div>
            <div class="setting-desc">{{ $t('profile.general.notifyQuestionDesc') }}</div>
          </div>
          <AppSwitch v-model:checked="notifyQuestionRequired" />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped lang="less">
.language-select {
  flex: 0 1 160px;
  min-width: 0;
}

.settings-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
}

/* Section 样式 */
.settings-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.section-title {
  margin: 0;
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  letter-spacing: 0.02em;
}

/* 设置列表 */
.settings-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.setting-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.setting-label {
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.setting-desc {
  font-size: 12px;
  color: var(--color-text-muted);
}
</style>
