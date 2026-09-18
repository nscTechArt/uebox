<script setup lang="ts">
/**
 * 项目设置
 *
 * 管的是「从盒子打开工程」这个动作前后发生什么。真相源在主进程
 * （`appSettingsManager`）—— 隐藏窗口这件事是在 `shell:openUproject` 里做的，
 * 覆盖所有从盒子启动工程的入口；这里的 ref 只是开关的显示态。
 */
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@renderer/utils/messageManager'
import AppSwitch from '@renderer/components/AppSwitch.vue'

const { t } = useI18n()

const hideWindowOnProjectLaunch = ref(false)

onMounted(async () => {
  try {
    const settings = await window.api.appSettings.get()
    // 只认 true，和主进程的兜底保持一致：读不出来时宁可不藏窗口
    hideWindowOnProjectLaunch.value = settings.hideWindowOnProjectLaunch === true
  } catch (error) {
    console.error('加载项目设置失败:', error)
  }
})

/**
 * 写回主进程。
 *
 * 走开关的 change 事件而不是 watch：watch 分不清「用户拨的」和「刚从主进程
 * 读回来的」，得靠一个「加载完了没有」的标志兜着，而那个标志本身又要和 Vue
 * 的异步 watch 抢时序 —— 抢输了就是打开设置页的一瞬间把用户设的值覆盖掉。
 */
async function applyHideWindowOnProjectLaunch(enabled: boolean): Promise<void> {
  hideWindowOnProjectLaunch.value = enabled
  try {
    await window.api.appSettings.set({ hideWindowOnProjectLaunch: enabled })
  } catch (error) {
    console.error('保存项目设置失败:', error)
    message.error(t('profile.general.settingSaveFailed'))
    hideWindowOnProjectLaunch.value = !enabled
  }
}
</script>

<template>
  <div class="settings-content">
    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.project.openBehavior') }}</h4>
      <div class="settings-list">
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.project.hideWindowOnLaunch') }}</div>
            <div class="setting-desc">{{ $t('profile.project.hideWindowOnLaunchDesc') }}</div>
          </div>
          <AppSwitch
            :checked="hideWindowOnProjectLaunch"
            @change="applyHideWindowOnProjectLaunch"
          />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped lang="less">
.settings-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
}

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
  flex: 1;
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
