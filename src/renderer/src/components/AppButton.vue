<script setup lang="ts">
/**
 * 全局按钮。整个应用只有这一套按钮长相。
 *
 * 接替 ant-design-vue 的 `<a-button>`（196 处）。ant-design-vue 最后一个 npm 版本
 * 是 2024-11 的 4.2.6，之后近两年没有代码发版，迟早要换掉 —— 按钮是它铺得最广的
 * 一块，先自己接管。做法和 [AppSwitch.vue] 一致：不是包一层 antd，是真的自己画。
 *
 * ## 长相不是新定的，是照搬现状
 *
 * 现在这套配色本来就写在 `antd-override.css` 里（连同它为什么这么定的理由），
 * 这里原样搬过来，所以换完**看不出变化**：
 *   primary  反相底：浅色主题近黑配白字，深色主题近白配黑字。主按钮靠**明度反差**
 *            而不是颜色 —— 界面上已经有蓝色链接和蓝色徽标，主按钮再用同一个蓝，
 *            它就只是「又一块蓝的」。底色跟页面差 18:1，边界够清楚，所以不描边。
 *   default  透明底 + 一圈 border，悬停加表面色
 *   dashed   同 default，边框改虚线
 *   soft     填色不描边的次动作（见下）
 *   text     无底无边，悬停才给表面色
 *   link     无底无边，文字走强调色
 *
 * ## soft 这一档是补的，补的原因是设置页各写各的
 *
 * 「复制路径」「打开目录」「添加一行」这类**又不是主操作、又需要看着像个按钮**
 * 的动作，设置页里一度有八套写法：`link-button`、`action-button`、`action-btn`、
 * `ghost-btn`、`archived-btn`、`reset-button`、`primary-btn`、`soft-action-button`，
 * 各自在自己的 `<style scoped>` 里定义一遍。同一页上两个按钮长得不一样，
 * 用户会以为它们的分量不同。
 *
 * 收敛时取的是其中最克制的那套（`soft-action-button`）：填一层浅底、不描边。
 * 只有一处改了 —— 原来那套的 hover 底色和默认底色是**同一个值**，鼠标划过去
 * 毫无反应；现在走 `--color-bg-soft` / `--color-bg-soft-hover` 这对专门的 token。
 *
 * 和 default 的分工：default 描边不填底，适合摆在卡片、表单这类已经有底色的
 * 容器里；soft 填底不描边，适合直接摆在设置页的空白上 —— 那里没有边框给它
 * 划边界，描边反而显得零碎。
 *
 * 禁用态**不许用 opacity** —— 它把整个按钮往背后的东西上拖，浅色主题下白字压在
 * 冲淡的暗底上会直接消失（见 docs/UI-Design-Standards.md §3.3 第 4 条）。
 * 所以禁用是换实色，不是降透明度。
 *
 * ## 尺寸沿用 antd 的控件高度
 *
 * small 24 / medium 32 / large 40，和输入框、选择框对得齐 —— 那些还是 antd，
 * 一行里混排不能差半格。注意 antd 管中号叫 `middle`，这里叫 `medium`：
 * 迁移时全仓有一处写着 `size="medium"`，在 antd 里是无效值、静默退回默认，
 * 改名之后这类笔误直接变成类型错误。
 */
import { computed, useSlots, type VNode } from 'vue'

interface Props {
  /** 视觉层级。antd 管这个叫 `type`，但按钮的「类型」本来就该指 html-type */
  variant?: 'primary' | 'default' | 'dashed' | 'soft' | 'text' | 'link'
  size?: 'small' | 'medium' | 'large'
  shape?: 'default' | 'circle' | 'round'
  /** 危险动作（删除、清空、覆盖），按钮转成红色语义 */
  danger?: boolean
  /** 撑满父容器宽度 */
  block?: boolean
  /** 透明底 + 描边，压在图片/深色区域上时用 */
  ghost?: boolean
  disabled?: boolean
  /** 转圈并挡住点击。挡点击是必须的，否则用户会重复提交 */
  loading?: boolean
  /** 原生 type。默认 button —— 放在 <form> 里时不写就会意外提交表单 */
  htmlType?: 'button' | 'submit' | 'reset'
  /** 没有可见文字时必填，否则读屏软件念不出这个按钮是干什么的 */
  ariaLabel?: string
  /**
   * 图标也可以当属性传（`:icon="h(PhPlus)"`）—— a-button 就收 VNode，
   * 全仓有这么用的地方。和 #icon 插槽二选一，插槽优先。
   */
  icon?: VNode
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'default',
  size: 'medium',
  shape: 'default',
  danger: false,
  block: false,
  ghost: false,
  disabled: false,
  loading: false,
  htmlType: 'button',
  ariaLabel: undefined,
  icon: undefined
})

const emit = defineEmits<{ (e: 'click', event: MouseEvent): void }>()

const slots = useSlots()
/** 只有图标、没有文字的按钮要收成方的，不然圆角按钮里一个图标会显得空 */
const iconOnly = computed(() => !slots.default)

const classes = computed(() => [
  'app-button',
  `app-button--${props.variant}`,
  `app-button--${props.size}`,
  {
    'app-button--circle': props.shape === 'circle',
    'app-button--round': props.shape === 'round',
    'app-button--danger': props.danger,
    'app-button--block': props.block,
    'app-button--ghost': props.ghost,
    'app-button--loading': props.loading,
    'app-button--icon-only': iconOnly.value
  }
])

function handleClick(event: MouseEvent): void {
  // loading 期间照样要挡住点击，否则用户会把请求打两遍
  if (props.disabled || props.loading) {
    event.preventDefault()
    event.stopPropagation()
    return
  }
  emit('click', event)
}
</script>

<template>
  <button
    :class="classes"
    :type="htmlType"
    :disabled="disabled || loading"
    :aria-label="ariaLabel"
    :aria-busy="loading || undefined"
    @click="handleClick"
  >
    <span v-if="loading" class="app-button__spinner" aria-hidden="true" />
    <slot v-else name="icon"><component :is="icon" v-if="icon" /></slot>
    <span v-if="slots.default" class="app-button__label"><slot /></span>
  </button>
</template>

<style scoped>
.app-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  box-sizing: border-box;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-primary);
  font-family: inherit;
  font-weight: 400;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color var(--motion-fast) var(--easing-standard),
    border-color var(--motion-fast) var(--easing-standard),
    color var(--motion-fast) var(--easing-standard);
}

/* 键盘焦点必须看得见 —— 鼠标点击不给焦点圈，Tab 过来才给 */
.app-button:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}

/* ---------- 尺寸：沿用 antd 的控件高度，好和还没换掉的输入框对齐 ---------- */
.app-button--small {
  height: 24px;
  padding: 0 var(--space-2);
  font-size: var(--font-size-sm);
  border-radius: var(--radius-xs);
}

.app-button--medium {
  height: 32px;
  padding: 0 var(--space-4);
  font-size: var(--font-size-base);
}

.app-button--large {
  height: 40px;
  padding: 0 var(--space-4);
  font-size: var(--font-size-md);
}

/* ---------- 形状 ---------- */
.app-button--round {
  border-radius: var(--radius-full);
}

.app-button--circle {
  border-radius: var(--radius-full);
  padding: 0;
  aspect-ratio: 1;
}

/* 纯图标按钮收成正方形，左右不留文字用的内边距 */
.app-button--icon-only:not(.app-button--block) {
  padding: 0;
  aspect-ratio: 1;
}

.app-button--block {
  display: flex;
  width: 100%;
}

/* ---------- primary：反相底，靠明度反差而不是颜色抢注意力 ---------- */
.app-button--primary {
  background: var(--color-bg-inverse);
  color: var(--color-text-inverse);
}

.app-button--primary:hover:not(:disabled) {
  background: var(--color-bg-inverse-hover);
}

/* ---------- default / dashed：透明底 + 描边 ---------- */
.app-button--default,
.app-button--dashed {
  border-color: var(--color-border);
}

.app-button--dashed {
  border-style: dashed;
}

.app-button--default:hover:not(:disabled),
.app-button--dashed:hover:not(:disabled) {
  background: var(--color-bg-surface-hover);
  border-color: var(--color-border-strong);
}

/* ---------- soft：填一层浅底，不描边。设置页里的次动作全走这一档 ---------- */
.app-button--soft {
  background: var(--color-bg-soft);
  color: var(--color-text-primary);
}

.app-button--soft:hover:not(:disabled) {
  background: var(--color-bg-soft-hover);
}

/* ---------- text / link：无底无边 ---------- */
.app-button--text:hover:not(:disabled) {
  background: var(--color-bg-surface-hover);
}

.app-button--link {
  color: var(--color-accent-text);
}

.app-button--link:hover:not(:disabled) {
  color: var(--color-accent-text);
  text-decoration: underline;
}

/* ---------- danger：覆盖上面各档的配色 ---------- */
.app-button--danger.app-button--primary {
  background: var(--color-danger-solid);
  color: var(--color-text-on-solid);
}

.app-button--danger.app-button--primary:hover:not(:disabled) {
  background: var(--color-danger-solid);
  filter: brightness(1.1);
}

.app-button--danger.app-button--default,
.app-button--danger.app-button--dashed {
  border-color: var(--color-danger-border);
  color: var(--color-danger-text);
}

/* soft 保留自己的填色底，只把字换成危险色 —— 描边是 default 的语言，
   给 soft 加边会让同一排按钮里那个危险的多出一圈框，看着像另一种控件 */
.app-button--danger.app-button--soft,
.app-button--danger.app-button--text,
.app-button--danger.app-button--link {
  color: var(--color-danger-text);
}

.app-button--danger:not(.app-button--primary):hover:not(:disabled) {
  background: var(--color-danger-bg);
  border-color: var(--color-danger-border);
  color: var(--color-danger-text);
}

/* ---------- ghost：压在图片/深色区域上 ---------- */
.app-button--ghost {
  background: transparent;
  border-color: var(--color-border-strong);
  color: var(--color-text-primary);
}

/* ---------- 禁用：换实色，不用 opacity ---------- */
/* 描边不能省：禁用底色是 surface-hover，而弹窗面板底色是 raised，深色下这俩是同一个灰，
   不画边的话弹窗里被禁用的按钮会整个消失，只剩一行浮空的灰字 */
.app-button:disabled {
  cursor: not-allowed;
  background: var(--color-bg-surface-hover);
  border-color: var(--color-border-subtle);
  color: var(--color-text-disabled);
}

/* text / link 的禁用态本来就没底，给底反而像多出一个块 */
.app-button--text:disabled,
.app-button--link:disabled {
  background: transparent;
  border-color: transparent;
  color: var(--color-text-disabled);
}

/* ---------- loading ---------- */
.app-button__spinner {
  width: 1em;
  height: 1em;
  flex: none;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: var(--radius-full);
  animation: spin 0.7s linear infinite;
}

.app-button__label {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}

@media (prefers-reduced-motion: reduce) {
  .app-button {
    transition: none;
  }

  .app-button__spinner {
    animation-duration: 2s;
  }
}
</style>
