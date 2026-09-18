<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@renderer/utils/messageManager'
import { useBridgeStatus, useConnectedProjects } from '@renderer/composables/useBridgeStatus'
import AppButton from '@renderer/components/AppButton.vue'
import AppSwitch from '@renderer/components/AppSwitch.vue'
import AppTag from '@renderer/components/AppTag.vue'

const { t } = useI18n()

const pluginSourceUrl = 'https://github.com/ueboxai/unreal-agent-link'
const autoEnableUnrealAgentLink = ref(true)
const isLoadingSettings = ref(true)
const isRepairingResidue = ref(false)

/**
 * 引擎桥接此刻是什么状态。
 *
 * 这一页原来只有一个「自动注入」开关和一个「修复并清理」按钮 —— 而 AI 在
 * 连不上引擎时会让用户「到设置里更新插件」。用户过来一看，没有任何地方说得出
 * 桥接起没起、有没有工程连着、端口是多少，那句话就成了一条死路。
 */
const bridge = useBridgeStatus()

/** 三态：null = 还没问到（别当成「没运行」报出去），否则按 state 判 */
const bridgeOnline = computed(() =>
  bridge.value ? bridge.value.state === 'listening' && !bridge.value.startError : null
)

/**
 * 连着的工程。
 *
 * **不能用 `bridge` 里的套接字数** —— 跑批的 commandlet、`-unattended`、
 * `-nullrhi` 都是连着的套接字，但都不是用户视角里的「工程」。下面那句说明还要
 * 用这个数字去推断「那个工程是不是没装插件」，数错了就是把用户推到一条错的排查路上。
 */
const connectedProjects = useConnectedProjects()

onMounted(async () => {
  try {
    const settings = await window.api.appSettings.get()
    autoEnableUnrealAgentLink.value = settings.autoEnableUnrealAgentLink
  } catch (error) {
    console.error('Failed to load plugin settings:', error)
  } finally {
    setTimeout(() => {
      isLoadingSettings.value = false
    }, 100)
  }
})

watch(autoEnableUnrealAgentLink, async (newValue) => {
  if (isLoadingSettings.value) return

  try {
    await window.api.appSettings.set({ autoEnableUnrealAgentLink: newValue })
    message.success(
      t(
        newValue
          ? 'profile.plugin.autoEnableUnrealAgentLinkEnabled'
          : 'profile.plugin.autoEnableUnrealAgentLinkDisabled'
      )
    )
  } catch (error) {
    console.error('Failed to save plugin settings:', error)
    message.error(t('profile.plugin.settingSaveFailed'))
  }
})

async function openPluginSource(): Promise<void> {
  try {
    const result = await window.api.shell.openExternal(pluginSourceUrl)
    if (!result?.success) {
      throw new Error(result?.error || 'Failed to open plugin source URL')
    }
  } catch (error) {
    console.error('Failed to open plugin source URL:', error)
    message.error(t('profile.plugin.sourceCodeOpenFailed'))
  }
}

async function repairEngineResidue(): Promise<void> {
  if (isRepairingResidue.value) return

  isRepairingResidue.value = true
  try {
    const result = await window.api.appSettings.repairUnrealAgentLinkEngineResidue()
    if (!result.success && result.failedEngines.length === 0) {
      throw new Error(result.error || 'Failed to repair UnrealAgentLink engine residue')
    }

    if (result.failedEngines.length > 0) {
      const firstFailedEngine =
        result.failedEngines[0]?.engineName || result.failedEngines[0]?.engineRootPath || '-'
      message.warning(
        t('profile.plugin.repairCleanupPartialFailed', {
          cleaned: result.cleanedEngineCount,
          failed: result.failedEngines.length,
          engine: firstFailedEngine
        })
      )
      return
    }

    if (result.cleanedEngineCount > 0) {
      message.success(
        t('profile.plugin.repairCleanupSuccess', {
          count: result.cleanedEngineCount
        })
      )
      return
    }

    message.success(t('profile.plugin.repairCleanupNothingToClean'))
  } catch (error) {
    console.error('Failed to repair UnrealAgentLink engine residue:', error)
    message.error(t('profile.plugin.repairCleanupFailed'))
  } finally {
    isRepairingResidue.value = false
  }
}
</script>

<template>
  <div class="settings-content">
    <!--
      桥接状态摆在最前面：用户被 AI 指到这一页来，第一个要回答的问题就是
      「到底连上没有」。
    -->
    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.plugin.status') }}</h4>
      <div class="settings-list">
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.plugin.bridgeState') }}</div>
            <div class="setting-desc">
              <template v-if="bridge?.startError">{{ bridge.startError }}</template>
              <template v-else-if="bridgeOnline === null">
                {{ $t('profile.plugin.bridgeUnknown') }}
              </template>
              <template v-else-if="bridgeOnline">
                {{ $t('profile.plugin.bridgeListening', { port: bridge?.port }) }}
              </template>
              <template v-else>{{ $t('profile.plugin.bridgeOffline') }}</template>
            </div>
          </div>
          <AppTag :tone="bridgeOnline === null ? 'neutral' : bridgeOnline ? 'success' : 'danger'">
            {{
              bridgeOnline === null
                ? $t('profile.plugin.bridgeChecking')
                : bridgeOnline
                  ? $t('profile.plugin.bridgeOn')
                  : $t('profile.plugin.bridgeOff')
            }}
          </AppTag>
        </div>

        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.plugin.connectedProjects') }}</div>
            <!--
              连接方向是反的：插件主动连过来，断了每 5 秒自己重试。
              这里把它说出来，省得用户去找一个不存在的「连接」按钮。
            -->
            <div class="setting-desc">{{ $t('profile.plugin.connectedProjectsDesc') }}</div>
          </div>
          <AppTag>{{ connectedProjects?.length ?? '—' }}</AppTag>
        </div>
      </div>
    </section>

    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.plugin.injectionBehavior') }}</h4>
      <div class="settings-list">
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.plugin.autoEnableUnrealAgentLink') }}</div>
            <div class="setting-desc">
              {{ $t('profile.plugin.autoEnableUnrealAgentLinkDesc') }}
            </div>
          </div>
          <AppSwitch v-model:checked="autoEnableUnrealAgentLink" />
        </div>
      </div>
    </section>

    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.plugin.resources') }}</h4>
      <div class="settings-list">
        <div class="setting-item setting-item-stack">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.plugin.repairCleanup') }}</div>
            <div class="setting-desc">{{ $t('profile.plugin.repairCleanupDesc') }}</div>
          </div>
          <div class="setting-actions">
            <AppButton variant="soft" :loading="isRepairingResidue" @click="repairEngineResidue">
              {{
                isRepairingResidue
                  ? $t('profile.plugin.repairCleanupRunning')
                  : $t('profile.plugin.repairCleanupAction')
              }}
            </AppButton>
          </div>
        </div>

        <div class="setting-item setting-item-stack">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.plugin.sourceCode') }}</div>
            <div class="setting-desc">{{ $t('profile.plugin.sourceCodeDesc') }}</div>
            <button class="source-link" type="button" @click="openPluginSource">
              {{ pluginSourceUrl }}
            </button>
          </div>
          <div class="setting-actions">
            <AppButton variant="soft" @click="openPluginSource">
              {{ $t('profile.plugin.sourceCodeOpen') }}
            </AppButton>
          </div>
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

.setting-item-stack {
  align-items: flex-start;
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

.setting-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.source-link {
  margin-top: var(--space-2);
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-accent-text);
  cursor: pointer;
  font-size: 12px;
  text-align: left;
  word-break: break-all;
}

.source-link:hover {
  color: var(--color-accent-text);
}
</style>
