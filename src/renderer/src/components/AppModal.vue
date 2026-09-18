<script setup lang="ts">
/**
 * 全局弹窗。接替 ant-design-vue 的 `<a-modal>`（54 处）。
 *
 * 命令式的那一半（确认框、提示框）已经收在 [utils/dialog.ts]，这里管声明式的：
 * 表单弹窗、详情弹窗这类自己拼内容的。
 *
 * ## 真正难的不是长相，是这四件事
 *
 * 1. **焦点陷阱**：打开后 Tab 不能跑到弹窗外面去。跑出去的话，键盘用户会在
 *    看不见的背景里乱按，而屏幕上还是那个弹窗。
 * 2. **焦点归位**：关掉之后焦点要回到打开它的那个元素。不还的话焦点落回
 *    `<body>`，键盘用户得从页头重新 Tab 一遍。
 * 3. **滚动锁**：弹窗开着时背景不能跟着滚。**而且要能叠**——弹窗里再开一个
 *    弹窗，关掉里面那个时不能把锁一起解了。所以用模块级计数，不是布尔。
 * 4. **Esc 关闭**：可以用 `:keyboard="false"` 关掉（比如正在上传，中途退出会留下半个文件）。
 *
 * ## 长相照搬现状
 *
 * 底色 `--color-bg-raised`、标题 `--color-text-primary`、头尾分隔线 `--color-border`
 * ——和原来 `antd-override.css` 里给 `.ant-modal-*` 的那几条一致。
 */
import { computed, nextTick, onBeforeUnmount, ref, useId, watch, type CSSProperties } from 'vue'
import { useI18n } from 'vue-i18n'

import AppButton from './AppButton.vue'

// Teleport 无法自动继承属性，统一交给实际的弹窗面板。
defineOptions({ inheritAttrs: false })

interface Props {
  open?: boolean
  title?: string
  /** 弹窗宽度，默认 520（antd 的默认值，换过来不会突然变宽变窄） */
  width?: number | string
  /** 不要底部那排按钮，自己在 default 插槽里拼 */
  hideFooter?: boolean
  okText?: string
  cancelText?: string
  /** 确定按钮转圈并挡住重复提交 */
  confirmLoading?: boolean
  /** 确定是危险动作（删除、覆盖） */
  okDanger?: boolean
  /** 确定按钮不可点（比如「输入库名以确认删除」还没输对） */
  okDisabled?: boolean
  /** 垂直居中，默认贴顶。内容矮的小弹窗居中好看，长表单贴顶才不会上下乱跳 */
  centered?: boolean
  /** 右上角的关闭叉，默认有 */
  closable?: boolean
  /** 点遮罩关闭，默认可以 */
  maskClosable?: boolean
  /** Esc 关闭，默认可以。上传/迁移这类中途退出会留下半成品的场景关掉它 */
  keyboard?: boolean
  /** 关闭后销毁内容。表单弹窗需要它，否则下次打开还留着上次的输入 */
  destroyOnClose?: boolean
  zIndex?: number
  /** 内容区的额外样式（去内边距、限高滚动这类） */
  bodyStyle?: CSSProperties
  /** 遮罩的额外样式。图片预览会把它压得更黑并加模糊 */
  maskStyle?: CSSProperties
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
  title: '',
  width: 520,
  hideFooter: false,
  okText: undefined,
  cancelText: undefined,
  confirmLoading: false,
  okDanger: false,
  okDisabled: false,
  centered: false,
  closable: true,
  maskClosable: true,
  keyboard: true,
  destroyOnClose: false,
  zIndex: 1000,
  bodyStyle: undefined,
  maskStyle: undefined
})

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'ok'): void
  (e: 'cancel'): void
}>()

const { t } = useI18n()

const panelRef = ref<HTMLElement | null>(null)
const titleId = `app-modal-title-${useId()}`
/** destroyOnClose 时用它决定内容还挂不挂在 DOM 上 */
const mounted = ref(props.open)

const panelWidth = computed(() =>
  typeof props.width === 'number' ? `${props.width}px` : props.width
)

/**
 * 打开着的弹窗数量。
 *
 * 必须是计数不是布尔：弹窗里再开一个弹窗，关掉里面那个时如果直接解锁，
 * 外面那个还开着，背景却能滚了。
 */
let openCount = 0
let savedOverflow = ''

function lockScroll(): void {
  if (openCount === 0) {
    savedOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  openCount += 1
}

function unlockScroll(): void {
  openCount = Math.max(0, openCount - 1)
  if (openCount === 0) document.body.style.overflow = savedOverflow
}

/** 关掉之后焦点要还回去 */
let previouslyFocused: HTMLElement | null = null

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

function focusables(): HTMLElement[] {
  const panel = panelRef.value
  if (!panel) return []
  return [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  )
}

function close(): void {
  emit('update:open', false)
  emit('cancel')
}

function onOk(): void {
  emit('ok')
}

function onMaskClick(): void {
  if (props.maskClosable) close()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.keyboard) {
    event.stopPropagation()
    close()
    return
  }
  if (event.key !== 'Tab') return

  // 焦点陷阱：到头了就绕回另一端，别让 Tab 跑到弹窗外面
  const items = focusables()
  if (items.length === 0) {
    event.preventDefault()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement as HTMLElement | null

  if (event.shiftKey && (active === first || !panelRef.value?.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(
  () => props.open,
  async (isOpen, wasOpen) => {
    if (isOpen === wasOpen) return

    if (isOpen) {
      previouslyFocused = document.activeElement as HTMLElement | null
      mounted.value = true
      lockScroll()
      await nextTick()
      // 先聚到面板本身而不是第一个按钮：聚到按钮上读屏软件只会念那个按钮，
      // 用户不知道弹出来的是什么
      panelRef.value?.focus()
      return
    }

    unlockScroll()
    if (props.destroyOnClose) mounted.value = false
    previouslyFocused?.focus?.()
    previouslyFocused = null
  },
  { immediate: true }
)

// 弹窗开着的时候组件被卸载（路由跳走等），锁不解就整个应用滚不动了
onBeforeUnmount(() => {
  if (props.open) unlockScroll()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="mounted"
      v-show="open"
      class="app-modal-root"
      :style="{ zIndex }"
      @keydown="onKeydown"
    >
      <div class="app-modal__mask" :style="maskStyle" @click="onMaskClick" />
      <div class="app-modal__wrap" :class="{ 'app-modal__wrap--centered': centered }">
        <div
          ref="panelRef"
          v-bind="$attrs"
          class="app-modal__panel"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="title ? titleId : undefined"
          tabindex="-1"
          :style="{ width: panelWidth }"
        >
          <header v-if="title || closable" class="app-modal__header">
            <h2 v-if="title" :id="titleId" class="app-modal__title">
              <slot name="title">{{ title }}</slot>
            </h2>
            <button
              v-if="closable"
              type="button"
              class="app-modal__close"
              :aria-label="t('common.close')"
              @click="close"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </header>

          <div class="app-modal__body" :style="bodyStyle">
            <slot />
          </div>

          <footer v-if="!hideFooter" class="app-modal__footer">
            <slot name="footer">
              <AppButton @click="close">{{ cancelText || t('common.cancel') }}</AppButton>
              <AppButton
                variant="primary"
                :danger="okDanger"
                :disabled="okDisabled"
                :loading="confirmLoading"
                @click="onOk"
              >
                {{ okText || t('common.confirm') }}
              </AppButton>
            </slot>
          </footer>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.app-modal-root {
  position: fixed;
  inset: 0;
}

.app-modal__mask {
  position: absolute;
  inset: 0;
  background: var(--color-bg-scrim);
}

/* 外层负责定位和滚动：弹窗比屏幕高时滚的是这一层，不是 body */
.app-modal__wrap {
  position: absolute;
  inset: 0;
  overflow: auto;
  display: flex;
  justify-content: center;
  padding: 100px var(--space-4) var(--space-6);
}

/* 居中时用 align-items 而不是把 padding 改成 auto：
   内容比屏幕高时 auto 会把顶部截掉，滚都滚不上去 */
.app-modal__wrap--centered {
  align-items: center;
  padding-top: var(--space-6);
}

.app-modal__wrap--centered .app-modal__panel {
  align-self: center;
}

.app-modal__panel {
  position: relative;
  align-self: flex-start;
  box-sizing: border-box;
  max-width: 100%;
  border-radius: var(--radius-md);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-pop);
  outline: none;
}

.app-modal__header {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-6);
  border-bottom: 1px solid var(--color-border);
}

.app-modal__title {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-md);
  font-weight: 600;
  line-height: 1.5;
}

.app-modal__close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.app-modal__close svg {
  width: 14px;
  height: 14px;
}

.app-modal__close:hover {
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
}

.app-modal__close:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}

.app-modal__body {
  padding: var(--space-6);
  color: var(--color-text-primary);
}

.app-modal__footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-4) var(--space-6);
  border-top: 1px solid var(--color-border);
}
</style>
