<script setup lang="ts">
import AppSegmented from '@renderer/components/AppSegmented.vue'
/**
 * AI 设置组件
 * 配置 AI Agent 相关的偏好设置
 * 样式与常规设置保持一致
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAIConfigStore, type AgentFollowUpBehavior } from '@renderer/store/modules/aiConfig'
import type { SendShortcut } from '@renderer/views/Assistant/composables/sendShortcut'
import ArchivedChatsModal from './ArchivedChatsModal.vue'
import AppButton from '@renderer/components/AppButton.vue'
import AppSwitch from '@renderer/components/AppSwitch.vue'

const aiConfigStore = useAIConfigStore()
const { t } = useI18n()

// 归档对话（侧边栏不再显示已归档，这里是唯一入口）
const showArchivedChats = ref(false)

// 「工具搜索（Beta）」和它管的那份工具清单一起搬去了「工具」页 ——
// 一个开关和它决定的那一百多个工具分在两页，用户看不出是同一套东西。

/**
 * 编辑器截图权限开关
 */
const editorScreenshotEnabled = computed({
  get: () => aiConfigStore.editorScreenshotEnabled,
  set: (value: boolean) => aiConfigStore.setEditorScreenshotEnabled(value)
})

/**
 * 智能追加提问开关
 */
const followUpSuggestionsEnabled = computed({
  get: () => aiConfigStore.followUpSuggestionsEnabled,
  set: (value: boolean) => aiConfigStore.setFollowUpSuggestionsEnabled(value)
})

// 「技能沉淀」那一档搬去了「个性化」页，和「它记了什么、怎么删掉」放在一起 ——
// 一个开关和它管的那份清单分在两页，用户看不出是同一套东西。

/**
 * 运行中打的字：排队还是插话。
 *
 * 存在 aiConfig store 里 —— 判定全发生在输入框那一层（这次回车走哪条路），
 * 主进程读不到也用不上。
 */
const FOLLOW_UP_BEHAVIORS: readonly AgentFollowUpBehavior[] = ['queue', 'steer']

const followUpBehavior = computed({
  get: () => aiConfigStore.followUpBehavior,
  set: (value: AgentFollowUpBehavior) => aiConfigStore.setFollowUpBehavior(value)
})

const followUpBehaviorHint = computed(() =>
  t(
    followUpBehavior.value === 'queue'
      ? 'profile.ai.followUpBehaviorQueueHint'
      : 'profile.ai.followUpBehaviorSteerHint'
  )
)

function followUpBehaviorLabel(behavior: AgentFollowUpBehavior): string {
  return t(
    behavior === 'queue' ? 'profile.ai.followUpBehaviorQueue' : 'profile.ai.followUpBehaviorSteer'
  )
}

/**
 * 哪个键算发送。
 *
 * 和上面那条挨着放：两条管的都是「在输入框里按下回车会发生什么」，
 * 分开的话用户要在两个地方拼出完整的键盘行为。
 */
const SEND_SHORTCUTS: readonly SendShortcut[] = ['enter', 'ctrl-enter']

const sendShortcut = computed({
  get: () => aiConfigStore.sendShortcut,
  set: (value: SendShortcut) => aiConfigStore.setSendShortcut(value)
})

function sendShortcutLabel(shortcut: SendShortcut): string {
  return t(
    shortcut === 'enter' ? 'profile.ai.sendShortcutEnter' : 'profile.ai.sendShortcutCtrlEnter'
  )
}

const sendShortcutHint = computed(() =>
  t(
    sendShortcut.value === 'enter'
      ? 'profile.ai.sendShortcutEnterHint'
      : 'profile.ai.sendShortcutCtrlEnterHint'
  )
)

/**
 * Agent 浏览器怎么显示。
 *
 * 存在应用设置里（主进程要在建窗口之前读它），不在 aiConfig store 里 ——
 * 那个 store 是渲染层的偏好，主进程读不到。
 */
type AgentBrowserMode = 'window' | 'embedded' | 'hidden'
const AGENT_BROWSER_MODES: readonly AgentBrowserMode[] = ['window', 'embedded', 'hidden']
const agentBrowserMode = ref<AgentBrowserMode>('embedded')

/**
 * agent 能读写电脑上的哪些位置。同样存在应用设置里 ——
 * 判定发生在主进程的工具里，渲染层的 store 那边读不到。
 */
type AgentFileAccessScope = 'ue-only' | 'full'
const FILE_ACCESS_SCOPES: readonly AgentFileAccessScope[] = ['ue-only', 'full']
const fileAccessScope = ref<AgentFileAccessScope>('full')

/**
 * 应用设置读回来了没有。
 *
 * 两个档位共用一个标志，因为它们来自**同一次** `appSettings.get()`。
 * 没有它的话，watch 会把 ref 的初始值当成用户的选择写回去 ——
 * 用户设的「仅虚幻相关」会在打开设置页的一瞬间被默认值覆盖掉。
 *
 * 置位要等一个 tick，见 `onMounted` 里那句 `await nextTick()`。
 */
const appSettingsLoaded = ref(false)

function agentBrowserModeLabel(mode: AgentBrowserMode): string {
  return t(`profile.ai.agentBrowser.${mode}`)
}

/** 当前档位下那一行小字。三档的差别 —— 尤其是「隐藏」的代价 —— 只有一句话说得清 */
const agentBrowserHint = computed(() => t(`profile.ai.agentBrowser.${agentBrowserMode.value}Hint`))

/** 用查表而不是模板字符串拼 key：`ue-only` 里有连字符，拼出来的路径解析不了 */
function fileAccessScopeLabel(scope: AgentFileAccessScope): string {
  return t(
    {
      'ue-only': 'profile.ai.fileAccessScopeUeOnly',
      full: 'profile.ai.fileAccessScopeFull'
    }[scope]
  )
}

/** 当前档位下那一行小字。两档到底差在哪，不写出来光看名字是猜不到的 */
const fileAccessScopeHint = computed(() =>
  t(
    {
      'ue-only': 'profile.ai.fileAccessScopeUeOnlyHint',
      full: 'profile.ai.fileAccessScopeFullHint'
    }[fileAccessScope.value]
  )
)

onMounted(async () => {
  try {
    const settings = await window.api.appSettings.get()
    agentBrowserMode.value = settings.agentBrowserMode ?? 'embedded'
    // 兜底跟主进程一字不差：只认 ue-only（那是用户主动选出来的收窄档），
    // 其余（含旧配置里根本没有这个字段）一律落到默认的 full。
    // 两边不一致的话，界面高亮的会和实际生效的对不上
    fileAccessScope.value = settings.agentFileAccessScope === 'ue-only' ? 'ue-only' : 'full'
  } catch (error) {
    console.error('读取应用设置失败:', error)
  } finally {
    // 等一个 tick 再置位。watch 默认是 pre 冲刷 —— 上面那两句赋值把回调排进了
    // 队列，队列到下一个 tick 才跑。当场置位的话，回调跑起来时标志已经是 true，
    // 于是刚读回来的值又被原样写回主进程一遍：白写一次盘，日志里还多一条
    // 「应用设置已保存」，看着像用户自己改了设置
    await nextTick()
    appSettingsLoaded.value = true
  }
})

/**
 * 改档位。
 *
 * 主进程收到后会把当前那个页面收掉 —— 不然用户切到「嵌入」之后，
 * 眼前还杵着一个独立窗口，而设置页显示的是另一回事。
 */
watch(agentBrowserMode, async (mode) => {
  if (!appSettingsLoaded.value) return
  try {
    await window.api.appSettings.set({ agentBrowserMode: mode })
  } catch (error) {
    console.error('设置 Agent 浏览器显示方式失败:', error)
  }
})

/** 改访问范围。下一次工具调用就生效，不用重启，也不影响正在跑的那一步 */
watch(fileAccessScope, async (scope) => {
  if (!appSettingsLoaded.value) return
  try {
    await window.api.appSettings.set({ agentFileAccessScope: scope })
  } catch (error) {
    console.error('设置文件访问范围失败:', error)
  }
})

// 技能沉淀的档位、提示语、以及「打开 Skills 目录」都搬去了 ProfilePersonalization.vue
</script>

<template>
  <div class="settings-content">
    <!-- 对话 Section -->
    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.ai.chatTitle') }}</h4>
      <div class="settings-list">
        <!--
          「敏感操作确认」这个开关删了：权限现在是每条会话自己的事，在输入框那个
          四档下拉上选（只读 / 请求批准 / 帮我批准 / 完全访问权限）。一个全局布尔
          开关既表达不了四档，也说不清它管的到底是哪条会话。
        -->
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.ai.followUpSuggestions') }}</div>
            <div class="setting-desc">{{ $t('profile.ai.followUpSuggestionsDesc') }}</div>
          </div>
          <AppSwitch v-model:checked="followUpSuggestionsEnabled" />
        </div>
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.ai.sendShortcut') }}</div>
            <div class="setting-desc">{{ sendShortcutHint }}</div>
          </div>
          <!-- @vue-generic {typeof SEND_SHORTCUTS[number]} -->
          <AppSegmented
            v-model="sendShortcut"
            :options="SEND_SHORTCUTS"
            :aria-label="$t('profile.ai.sendShortcut')"
          >
            <template #default="{ option }">
              {{ sendShortcutLabel(option) }}
            </template>
          </AppSegmented>
        </div>
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.ai.followUpBehavior') }}</div>
            <div class="setting-desc">{{ followUpBehaviorHint }}</div>
          </div>
          <!-- @vue-generic {typeof FOLLOW_UP_BEHAVIORS[number]} -->
          <AppSegmented
            v-model="followUpBehavior"
            :options="FOLLOW_UP_BEHAVIORS"
            :aria-label="$t('profile.ai.followUpBehavior')"
          >
            <template #default="{ option }">
              {{ followUpBehaviorLabel(option) }}
            </template>
          </AppSegmented>
        </div>
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.ai.agentBrowserMode') }}</div>
            <div class="setting-desc">{{ agentBrowserHint }}</div>
          </div>
          <!-- @vue-generic {typeof AGENT_BROWSER_MODES[number]} -->
          <AppSegmented
            v-model="agentBrowserMode"
            :options="AGENT_BROWSER_MODES"
            :aria-label="$t('profile.ai.agentBrowserMode')"
          >
            <template #default="{ option }">
              {{ agentBrowserModeLabel(option) }}
            </template>
          </AppSegmented>
        </div>
        <!-- 「管理 Skills」也搬去了个性化页：那里同时列着有哪些技能、能逐条删 -->
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.ai.archivedChats') }}</div>
            <div class="setting-desc">{{ $t('profile.ai.archivedChatsDesc') }}</div>
          </div>
          <AppButton variant="soft" @click="showArchivedChats = true">
            {{ $t('profile.ai.openArchivedChats') }}
          </AppButton>
        </div>
      </div>
    </section>

    <!-- 隐私 Section -->
    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.ai.privacyTitle') }}</h4>
      <div class="settings-list">
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.ai.fileAccessScope') }}</div>
            <div class="setting-desc">{{ fileAccessScopeHint }}</div>
          </div>
          <!-- @vue-generic {typeof FILE_ACCESS_SCOPES[number]} -->
          <AppSegmented
            v-model="fileAccessScope"
            :options="FILE_ACCESS_SCOPES"
            :aria-label="$t('profile.ai.fileAccessScope')"
          >
            <template #default="{ option }">
              {{ fileAccessScopeLabel(option) }}
            </template>
          </AppSegmented>
        </div>
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ $t('profile.ai.editorScreenshot') }}</div>
            <div class="setting-desc">{{ $t('profile.ai.editorScreenshotDesc') }}</div>
          </div>
          <AppSwitch v-model:checked="editorScreenshotEnabled" />
        </div>
      </div>
    </section>

    <!-- 归档对话 -->
    <ArchivedChatsModal v-model:visible="showArchivedChats" />
  </div>
</template>

<style scoped lang="less">
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

.setting-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: 14px 16px;
  border-radius: var(--radius-lg);
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
}

.provider-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  border-radius: 16px;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
}

.provider-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.provider-field-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.provider-field-title {
  font-size: 13px;
  color: var(--color-text-primary);
}

.provider-input {
  width: 100%;
  min-height: 38px;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-sunken);
  color: var(--color-text-primary);
  font-size: 13px;
  outline: none;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

.provider-input:focus {
  border-color: var(--color-accent-border);
  box-shadow: 0 0 0 3px var(--color-accent-border);
}

.provider-input::placeholder {
  color: var(--color-text-secondary);
}

.provider-secret-wrap {
  position: relative;
}

.provider-secret-input {
  padding-right: 42px;
}

.provider-visibility-btn {
  position: absolute;
  top: 50%;
  right: 10px;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.provider-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}

.provider-save-btn {
  min-width: 132px;
  height: 34px;
  padding: 0 18px;
  border: 0;
  border-radius: 10px;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.provider-save-btn:hover:not(:disabled) {
  background: var(--color-bg-surface-hover);
}

.provider-save-btn:disabled {
  cursor: not-allowed;
  color: var(--color-text-disabled);
}

.provider-status {
  font-size: 12px;
  line-height: 1.5;
}

.provider-status.success {
  color: var(--color-success-text);
}

.provider-status.error {
  color: var(--color-warning-text);
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.text-input {
  width: 100%;
  min-height: 36px;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-sunken);
  color: var(--color-text-primary);
  font-size: 13px;
  outline: none;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease;

  &:focus {
    border-color: var(--color-accent-border);
    box-shadow: 0 0 0 3px var(--color-accent-border);
  }

  &::placeholder {
    color: var(--color-text-secondary);
  }
}

.setting-note {
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.setting-warning {
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-warning-text);
}
</style>
