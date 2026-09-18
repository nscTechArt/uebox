<script setup lang="ts">
/**
 * 快捷键设置组件
 * 原型风格：表格布局 + 键盘按键样式
 */
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useShortcutStore, type Shortcut } from '@/store/modules/shortcut'
import AppSwitch from '@renderer/components/AppSwitch.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { interpretRecordingKey } from './shortcutRecording'
import { message } from '@renderer/utils/messageManager'
import { acceleratorKeyLabels } from '@renderer/utils/accelerator'

const { t, te } = useI18n()
const shortcutStore = useShortcutStore()
const recordingKey = ref<string | null>(null)
/** 录制过程中要告诉用户的话：按了不带修饰键的全局热键、或者注册没成功 */
const recordingError = ref('')

/** 是否存在快捷键冲突 */
const hasConflicts = computed(() => shortcutStore.conflicts.length > 0)

/**
 * 只在开发环境列出的快捷键。
 *
 * 「刷新页面 / 强制刷新页面」是 Electron 调试习惯：用户看到的是一个应用而不是网页，
 * 误按一次会把正在进行的对话和导入连同渲染进程一起扔掉。正式包里 View 菜单也不显示
 * 这两项（见 `main/services/shortcutService.ts`），这里跟着一起藏，免得列出一条
 * 改了绑定却没有任何菜单入口的快捷键。
 */
// app.force_reload 不在 DEFAULT_SHORTCUTS 里，数据库中从来没有这一行，列在这儿是白列的
const DEV_ONLY_ACTION_KEYS = new Set(['app.reload'])

/** 可见的快捷键列表 */
const visibleShortcuts = computed(() => {
  if (import.meta.env.DEV) return shortcutStore.shortcuts
  return shortcutStore.shortcuts.filter((s) => !DEV_ONLY_ACTION_KEYS.has(s.action_key))
})

onMounted(async () => {
  await shortcutStore.fetchShortcuts()
  // 获取快捷键冲突状态
  await shortcutStore.fetchConflicts()
})

/**
 * 格式化快捷键为独立按键数组
 */
const formatAcceleratorKeys = (acc: string): string[] => {
  if (!acc) return [t('profile.shortcuts.none')]
  return acceleratorKeyLabels(acc, window.api.platform)
}

/**
 * 处理录制中的按键。
 *
 * 判据全在 shortcutRecording.ts 里 —— 那里说明了 Esc / 裸 Tab / 全局热键必须带修饰键
 * 这三条为什么是正确性问题而不是手感问题。
 */
const handleKeyDown = async (e: KeyboardEvent, shortcut: Shortcut): Promise<void> => {
  const outcome = interpretRecordingKey(e, shortcut.type, window.api.platform)

  // 裸 Tab 要放行给焦点导航，所以只在真的要吃掉这次按键时才 preventDefault
  if (outcome.kind !== 'cancel' || e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
  }

  if (outcome.kind === 'pending') return

  if (outcome.kind === 'cancel') {
    stopRecording()
    return
  }

  if (outcome.kind === 'rejected') {
    recordingError.value = t('profile.shortcuts.needsModifier')
    return
  }

  const ok = await shortcutStore.updateShortcut(shortcut.action_key, {
    accelerator: outcome.accelerator
  })
  if (!ok) {
    // 注册失败（多半是被别的程序占了）。原来这里什么都不说，用户会以为改好了，
    // 按下去却没反应
    recordingError.value = t('profile.shortcuts.updateFailed')
    return
  }
  stopRecording()
  await shortcutStore.fetchConflicts()
}

/**
 * 开始录制。
 *
 * 只能由用户明确点「修改」触发。这里原来绑的是行的 @focus —— 用键盘 Tab 到某一行就进入
 * 录制，再按一次 Tab 想跳下一行，那一下就被录成了「全局热键 = Tab」并立刻注册到系统。
 */
const startRecording = (key: string): void => {
  recordingKey.value = key
  recordingError.value = ''
}

const stopRecording = (): void => {
  recordingKey.value = null
  recordingError.value = ''
}

/**
 * 重置为默认
 */
const resetToDefault = async (): Promise<void> => {
  const success = await shortcutStore.resetToDefault()
  if (success) {
    // 这里原来只写 console —— 用户点完看不出发生了什么
    message.success(t('profile.shortcuts.resetDone'))
    await shortcutStore.fetchConflicts()
  }
}

/**
 * 切换快捷键启用状态
 */
const toggleShortcut = async (shortcut: Shortcut): Promise<void> => {
  const newEnabled = !shortcut.enabled
  await shortcutStore.updateShortcut(shortcut.action_key, { enabled: newEnabled })
}
</script>

<template>
  <div class="shortcuts-content">
    <!-- 快捷键冲突警告 -->
    <div v-if="hasConflicts" class="conflicts-warning">
      <div class="conflicts-icon">⚠️</div>
      <div class="conflicts-content">
        <div class="conflicts-title">{{ $t('profile.shortcuts.conflictTitle') }}</div>
        <div class="conflicts-list">
          <div
            v-for="conflict in shortcutStore.conflicts"
            :key="conflict.actionKey"
            class="conflict-item"
          >
            <span class="conflict-shortcut">{{
              formatAcceleratorKeys(conflict.shortcut).join(' + ')
            }}</span>
            <span class="conflict-error">{{
              conflict.error || $t('profile.shortcuts.occupied')
            }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 顶部说明 -->
    <div class="shortcuts-header">
      <div class="header-desc">{{ $t('profile.shortcuts.globalHotkeysDesc') }}</div>
      <AppButton variant="soft" size="medium" @click="resetToDefault">
        {{ $t('profile.shortcuts.resetDefault') }}
      </AppButton>
    </div>

    <!-- 快捷键表格 -->
    <div class="shortcuts-table-wrapper">
      <table class="shortcuts-table">
        <tbody>
          <!--
            录制由「修改」按钮显式开启，不再绑 @focus：绑 focus 时用键盘 Tab 遍历这张表，
            下一次 Tab 就会被录成「全局热键 = Tab」并立刻注册到操作系统
          -->
          <tr
            v-for="shortcut in visibleShortcuts"
            :key="shortcut.action_key"
            class="shortcut-row"
            :class="{ disabled: !shortcut.enabled }"
            @keydown="(e) => recordingKey === shortcut.action_key && handleKeyDown(e, shortcut)"
          >
            <td class="shortcut-name">
              {{
                te(`profile.shortcuts.action.${shortcut.action_key}`)
                  ? t(`profile.shortcuts.action.${shortcut.action_key}`)
                  : shortcut.description
              }}
            </td>
            <td class="shortcut-keys">
              <div v-if="recordingKey === shortcut.action_key" class="recording-cell">
                <div class="recording-indicator">
                  {{ $t('profile.shortcuts.recording') }}
                </div>
                <div v-if="recordingError" class="recording-error">{{ recordingError }}</div>
              </div>
              <div v-else class="keys-container">
                <template
                  v-for="(key, index) in formatAcceleratorKeys(shortcut.accelerator)"
                  :key="index"
                >
                  <span class="kbd-key">{{ key }}</span>
                  <span
                    v-if="index < formatAcceleratorKeys(shortcut.accelerator).length - 1"
                    class="key-separator"
                    >+</span
                  >
                </template>
              </div>
            </td>
            <td class="shortcut-record">
              <AppButton
                v-if="recordingKey === shortcut.action_key"
                variant="text"
                size="small"
                @click="stopRecording"
              >
                {{ $t('common.cancel') }}
              </AppButton>
              <AppButton
                v-else
                variant="text"
                size="small"
                @click="startRecording(shortcut.action_key)"
              >
                {{ $t('profile.shortcuts.change') }}
              </AppButton>
            </td>
            <td class="shortcut-toggle">
              <AppSwitch
                :checked="shortcut.enabled"
                @mousedown.stop.prevent
                @click.stop="toggleShortcut(shortcut)"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped lang="less">
.shortcuts-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
}

/* 冲突警告 */
.conflicts-warning {
  display: flex;
  gap: 12px;
  padding: 12px 16px;
  background: var(--color-warning-bg);
  border: 1px solid var(--color-warning-border);
  border-radius: 8px;
  margin-bottom: 8px;
}

.conflicts-icon {
  font-size: 20px;
  line-height: 1;
}

.conflicts-content {
  flex: 1;
}

.conflicts-title {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-warning-text);
  margin-bottom: 4px;
}

.conflicts-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.conflict-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-size-xs);
}

.conflict-shortcut {
  background: var(--color-warning-bg);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
  color: var(--color-warning-text);
}

.conflict-error {
  color: var(--color-text-secondary);
}

.recording-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.recording-error {
  color: var(--color-danger-text);
  font-size: var(--font-size-sm);
}

.shortcut-record {
  text-align: right;
  white-space: nowrap;
}

/* 顶部说明 */
.shortcuts-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-4);
}

.header-desc {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

/* 快捷键表格 */
.shortcuts-table-wrapper {
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border-subtle);
  overflow: hidden;
}

.shortcuts-table {
  width: 100%;
  text-align: left;
  border-collapse: collapse;
}

.shortcut-row {
  transition: background 0.2s ease;
  border-bottom: 1px solid var(--color-border-subtle);
  cursor: pointer;
  outline: none;

  &:last-child {
    border-bottom: none;
  }

  &:hover {
    background: var(--color-bg-surface-hover);

    .edit-icon {
      opacity: 1;
    }
  }

  &:focus {
    background: var(--color-accent-bg);
    outline: none;
  }
}

.shortcut-name {
  padding: 16px 16px;
  font-size: var(--font-size-xs);
  color: var(--color-text-primary);
}

.shortcut-keys {
  padding: 16px;
  text-align: right;
}

.keys-container {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}

/* 键盘按键样式 */
.kbd-key {
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  border-bottom-width: 2px;
  border-radius: 4px;
  padding: 2px 6px;
  font-family: monospace;
  font-size: 12px;
  color: var(--color-text-primary);
  min-width: 20px;
  text-align: center;
}

.key-separator {
  font-size: 12px;
  color: var(--color-text-muted);
}

.recording-indicator {
  font-size: var(--font-size-xs);
  color: var(--color-accent-text);
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}

.shortcut-toggle {
  padding: 16px;
  text-align: right;
  width: 60px;
}

/* Disabled row state */
.shortcut-row.disabled {
  .shortcut-name,
  .shortcut-keys {
    opacity: 0.4;
  }

  .kbd-key {
    background: var(--color-bg-surface-hover);
    border-color: var(--color-border-subtle);
    color: var(--color-text-muted);
  }
}
</style>
