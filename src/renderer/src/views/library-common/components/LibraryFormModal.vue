<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { useI18n } from 'vue-i18n'

/**
 * 蓝图库 / 材质库共用的新建 · 编辑弹窗外壳。
 *
 * 抽出来之前，两个库各自有一份逐字相同的 500 行弹窗样式 —— 改一处忘另一处，
 * 两边的「新建」就会慢慢长歪。这里只管**外壳**：遮罩、卡片、标题栏、
 * 可折叠的高级区、底部按钮，以及表单控件的统一外观（`.form-input` 这类
 * 通过 `:deep()` 作用到插槽内容上）。
 *
 * 领域内容（蓝图的类型网格、引擎版本胶囊；材质的类型下拉）留在各自的
 * 调用方，因为它们本来就不一样，塞进来只会让这个组件长出一堆 if。
 */
const props = withDefaults(
  defineProps<{
    /** 是否打开（v-model:open） */
    open: boolean
    /** 标题栏文案 */
    title: string
    /** 标题栏图标：新建用加号，编辑用铅笔，导入向导用箱子 */
    icon?: 'plus' | 'edit' | 'import'
    /**
     * 面板宽度。
     * default 420–500，wide 640（内容里有网格），wizard 760（多步向导的两栏预览）
     */
    size?: 'default' | 'wide' | 'wizard'
    /** 确认按钮文案。给了 actions 插槽时不用传 */
    confirmText?: string
    /** 取消按钮文案。给了 actions 插槽时不用传 */
    cancelText?: string
    /** 确认按钮是否禁用（如名称为空） */
    confirmDisabled?: boolean
    /** 高级区是否展开（v-model:advancedExpanded），有 advanced 插槽时才有意义 */
    advancedExpanded?: boolean
    /** 高级区折叠条上的次要提示，如「蓝图类型、引擎版本、描述」 */
    advancedHint?: string
    /** 高级区折叠条主文案，默认「高级设置」 */
    advancedLabel?: string
  }>(),
  {
    icon: 'plus',
    size: 'default',
    confirmText: '',
    cancelText: '',
    confirmDisabled: false,
    advancedExpanded: false,
    advancedHint: '',
    advancedLabel: ''
  }
)

const emit = defineEmits<{
  'update:open': [open: boolean]
  'update:advancedExpanded': [expanded: boolean]
  confirm: []
}>()

const { t } = useI18n()

const advancedLabelText = computed(() => props.advancedLabel || t('libraryCommon.modal.advanced'))

function close(): void {
  emit('update:open', false)
}

/*
 * Esc 关闭。挂在 window 而不是面板上：焦点可能停在遮罩、也可能被内容里的
 * 组件抢走（比如原生 select 展开时），只有 window 一定收得到。
 */
function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') close()
}

watch(
  () => props.open,
  (open) => {
    if (open) window.addEventListener('keydown', onWindowKeydown)
    else window.removeEventListener('keydown', onWindowKeydown)
  },
  { immediate: true }
)

onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown))

function toggleAdvanced(): void {
  emit('update:advancedExpanded', !props.advancedExpanded)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="modal-overlay" @click.self="close">
        <div class="modal-box" :class="`size-${size}`">
          <div class="modal-header">
            <svg
              class="header-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <template v-if="icon === 'edit'">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </template>
              <template v-else-if="icon === 'import'">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </template>
              <template v-else>
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </template>
            </svg>
            <div class="modal-title">{{ title }}</div>
            <button class="modal-close" :title="t('libraryCommon.close')" @click="close">✕</button>
          </div>

          <div class="modal-body">
            <slot />

            <div v-if="$slots.advanced" class="advanced-section">
              <button type="button" class="advanced-toggle" @click="toggleAdvanced">
                <span v-if="advancedHint" class="toggle-hint">{{ advancedHint }}</span>
                <span class="toggle-text">{{ advancedLabelText }}</span>
                <span class="toggle-icon" :class="{ expanded: advancedExpanded }">
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </span>
              </button>

              <Transition name="expand">
                <div v-show="advancedExpanded" class="advanced-content">
                  <slot name="advanced" />
                </div>
              </Transition>
            </div>
          </div>

          <div class="modal-actions">
            <!-- 多步向导的按钮每一步都不一样，整块交给调用方 -->
            <slot name="actions">
              <button type="button" class="btn-cancel" @click="close">{{ cancelText }}</button>
              <button
                type="button"
                class="btn-confirm"
                :disabled="confirmDisabled"
                @click="emit('confirm')"
              >
                {{ confirmText }}
              </button>
            </slot>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped lang="less">
/*
 * 遮罩带着 backdrop-filter，所以**不能**在它自己身上动画 opacity ——
 * Chromium 在 opacity 边界上会把渲染面丢掉再重建，模糊整帧弹进弹出，看着就是「闪一下」。
 * 见 crbug 1194050「backdrop-filter blur disappears during transition」。
 * 改成让底色和模糊本身过渡；opacity 只留给上面那张卡片，它没有模糊。
 */
.modal-enter-active,
.modal-leave-active {
  transition:
    background-color 0.3s ease,
    backdrop-filter 0.3s ease;

  .modal-box {
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }
}

.modal-enter-from,
.modal-leave-to {
  background-color: transparent;
  backdrop-filter: blur(0);

  .modal-box {
    transform: scale(0.95) translateY(10px);
    opacity: 0;
  }
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--color-bg-scrim);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-box {
  background: var(--color-bg-raised);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xl);
  padding: 0;
  min-width: 420px;
  max-width: 500px;
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
  overflow: hidden;

  &.size-wide {
    // 宽一点以容纳网格
    max-width: 640px;
    width: 90vw;
  }

  &.size-wizard {
    // 多步向导：预览步是左右两栏，再窄就挤了
    max-width: 760px;
    width: 90vw;
  }
}

.modal-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--color-border);
  background: linear-gradient(180deg, var(--color-bg-surface) 0%, transparent 100%);

  .header-icon {
    width: 20px;
    height: 20px;
    color: var(--color-accent-text);
  }
}

.modal-title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
  margin: 0;
}

.modal-close {
  margin-left: auto;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  transition: all 0.2s ease;

  &:hover {
    background: var(--color-bg-raised);
    color: var(--color-text-primary);
  }
}

.modal-body {
  padding: 20px 24px;
  overflow-y: auto;
  max-height: 70vh;

  &::-webkit-scrollbar {
    width: 6px;
  }

  &::-webkit-scrollbar-thumb {
    background: var(--color-bg-raised);
    border-radius: 3px;
  }
}

// ===== 高级设置折叠区 =====
.advanced-section {
  border-top: 1px solid var(--color-border);
  padding-top: 16px;
  margin-top: 4px;
}

.advanced-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 0;
  background: transparent;
  border: none;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: color 0.2s;
  text-align: left;

  &:hover {
    color: var(--color-text-primary);
  }

  .toggle-hint {
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
    margin-right: auto;
    order: 1;
  }

  .toggle-text {
    font-size: var(--font-size-base);
    font-weight: var(--font-weight-medium);
    order: 2;
  }

  .toggle-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: var(--radius-xs);
    background: var(--color-bg-surface-hover);
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    order: 3;

    svg {
      transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }

    &.expanded {
      background: var(--color-accent-bg);
      color: var(--color-accent-text);

      svg {
        transform: rotate(180deg);
      }
    }
  }
}

.expand-enter-active,
.expand-leave-active {
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  overflow: hidden;
}

.expand-enter-from,
.expand-leave-to {
  opacity: 0;
  max-height: 0;
  transform: translateY(-10px);
}

.expand-enter-to,
.expand-leave-from {
  opacity: 1;
  max-height: 500px;
  transform: translateY(0);
}

.advanced-content {
  padding-top: 8px;
}

// ===== 底部动作条 =====
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 24px;
  background: var(--color-bg-sunken);
  border-top: 1px solid var(--color-border);
}

// 用 :deep() 而不是裸选择器：actions 插槽里的按钮带的是调用方的 scope id，
// 裸选择器够不着它们，多步向导的按钮会掉回浏览器默认样式。
.modal-actions :deep(.btn-cancel) {
  padding: 8px 20px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border-strong);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }
}

.modal-actions :deep(.btn-confirm) {
  padding: 8px 24px;
  border-radius: var(--radius-md);
  border: 1px solid transparent;
  background: var(--color-accent-solid);
  color: var(--color-text-on-solid);
  font-size: 13px;
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: all 0.2s;

  &:hover:not(:disabled) {
    background: var(--color-accent-solid-hover);
    transform: translateY(-1px);
  }

  &:active:not(:disabled) {
    transform: translateY(0);
  }

  &:disabled {
    cursor: not-allowed;
    background: var(--color-bg-raised);
    border-color: transparent;
    color: var(--color-text-disabled);
  }
}

// ===== 插槽内的表单控件 =====
// 插槽内容带的是调用方的 scope id，所以只能用 :deep() 穿透。
// 放在这里而不是各自的页面里，是为了让两个库的表单长得一模一样。
.modal-body :deep(.name-section) {
  margin-bottom: 20px;

  .name-input {
    font-size: var(--font-size-md);
    padding: 14px 16px;
    background: var(--color-bg-sunken);
    border: 1px solid var(--color-border-strong);

    &:focus {
      border-color: var(--color-accent-border);
      box-shadow: 0 0 0 4px var(--color-accent-border);
    }
  }
}

.modal-body :deep(.form-group) {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.modal-body :deep(.form-label) {
  display: flex;
  align-items: center;
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  color: var(--color-text-secondary);
  margin-bottom: 8px;
  margin-top: 16px;

  &:first-of-type {
    margin-top: 0;
  }
}

.modal-body :deep(.form-input) {
  width: 100%;
  padding: 10px 14px;
  background: var(--color-bg-sunken);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
  outline: none;
  box-sizing: border-box;
  transition: all 0.2s;

  &::placeholder {
    color: var(--color-text-disabled);
  }

  &:focus {
    border-color: var(--color-accent-border);
    box-shadow: 0 0 0 3px var(--color-accent-border);
  }
}

.modal-body :deep(.form-textarea) {
  // 不给缩放手柄：用户拖大了会把弹窗撑变形
  resize: none;
  min-height: 100px;
  font-family: inherit;
  line-height: var(--line-height-normal);
}
</style>
