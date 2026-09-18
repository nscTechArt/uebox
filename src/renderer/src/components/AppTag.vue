<script setup lang="ts">
/**
 * 标签。接替 ant-design-vue 的 `<a-tag>`（12 处），也是资产标签、智能分类、
 * 路径标签、标签选择器里唯一的标签写法。
 *
 * ## 一套语法，三档份量
 *
 * 以前同一个"标签"概念在界面上有五种长相：详情面板的 100px 胶囊、智能分类的
 * 彩色方块、路径标签的 emoji 方块、选择器里的 12px 圆角大卡片、选择器底部的
 * 光秃秃文字。用户看不出它们是同一种东西。现在统一成一个形状，只靠**份量**分：
 *
 * - `variant="filled"`（默认）：淡底 + 描边 —— 用户自己打的、能删的标签
 * - `variant="outline"`：透明底 + 描边 + 更淡的文字 —— 机器推断的，只读
 * - `variant="dashed"`：虚线描边 —— "新建 / 添加"这类占位动作
 *
 * 类别不靠给整块染色来表达（21 种硬编码底色配固定前景，深浅两个主题各挂一半，
 * 实测 Metallic 只有 2.6:1），改成前置一个小色点：文字永远在中性底上，对比度
 * 由 token 保证，颜色只负责扫视分组。
 *
 * ## 按语义分档，不照抄 antd 的颜色名
 *
 * antd 那边写的是 `color="green"` / `"volcano"` / `"gold"` —— 颜色名不告诉你
 * 这个标签在说什么，换主题时也没法跟着走（硬编码颜色还会被 `pnpm verify:colors` 拦）。
 * 这里收的是**意图**：成功 / 警告 / 危险 / 提示 / 中性，各自挂到已有的语义 token 上。
 *
 * 对照关系（迁移时按这个换的）：
 *   green → success，orange / gold / volcano → warning，
 *   red → danger，blue → info，default → neutral
 */
import type { Component } from 'vue'
import { PhX } from '@phosphor-icons/vue'
import type { TagTone } from './AppTag.types'

interface Props {
  tone?: TagTone
  /** small = 20px（状态标签），medium = 24px（带操作的实体标签） */
  size?: 'small' | 'medium'
  variant?: 'filled' | 'outline' | 'dashed'
  /** 前置色点。只接受调色板变量，例如 `var(--color-uetype-texture)` */
  dot?: string
  /** 前置图标组件（和 dot 二选一） */
  icon?: Component
  /** 整块可点：渲染成 button，并显示选中/添加的指示 */
  interactive?: boolean
  selected?: boolean
  /** 右侧删除按钮。与 interactive 互斥 —— button 不能套 button */
  removable?: boolean
  removeLabel?: string
}

withDefaults(defineProps<Props>(), {
  tone: 'neutral',
  size: 'small',
  variant: 'filled',
  dot: undefined,
  icon: undefined,
  removeLabel: undefined
})

defineEmits<{
  (e: 'click'): void
  (e: 'remove'): void
}>()
</script>

<template>
  <component
    :is="interactive ? 'button' : 'span'"
    :type="interactive ? 'button' : undefined"
    :class="[
      'app-tag',
      `app-tag--${tone}`,
      `app-tag--${size}`,
      `app-tag--${variant}`,
      {
        'app-tag--interactive': interactive,
        'app-tag--selected': selected,
        'app-tag--removable': removable
      }
    ]"
    :aria-pressed="interactive ? selected : undefined"
    @click="interactive && $emit('click')"
  >
    <span v-if="dot" class="app-tag__dot" :style="{ background: dot }"></span>
    <component :is="icon" v-else-if="icon" class="app-tag__icon" />

    <span class="app-tag__label"><slot /></span>

    <button
      v-if="removable"
      type="button"
      class="app-tag__remove"
      :aria-label="removeLabel"
      :title="removeLabel"
      @click.stop="$emit('remove')"
    >
      <PhX />
    </button>
  </component>
</template>

<style scoped>
.app-tag {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0 var(--space-2);
  height: 20px;
  max-width: 100%;
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  font-family: inherit;
  font-size: var(--font-size-sm);
  line-height: 1;
  white-space: nowrap;
}

.app-tag--medium {
  height: 24px;
}

/* 有删除按钮时右边收窄，让 ✕ 的点击区贴着边而不是浮在留白里 */
.app-tag--removable {
  padding-right: var(--space-1);
}

.app-tag__label {
  overflow: hidden;
  text-overflow: ellipsis;
  /* 单个超长标签不许把整块面板撑开 */
  max-width: 180px;
}

.app-tag__dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
}

.app-tag__icon {
  flex-shrink: 0;
  font-size: 12px;
  opacity: 0.75;
}

/*
 * 每档都是「淡底 + 同色描边 + 同色文字」。
 * 不用实色底 + 白字：标签往往一行里挤好几个，实色块连成一片会盖过正文。
 */
.app-tag--neutral {
  background: var(--color-bg-surface-hover);
  border-color: var(--color-border);
  color: var(--color-text-secondary);
}

.app-tag--success {
  background: var(--color-success-bg);
  border-color: var(--color-success-border);
  color: var(--color-success-text);
}

.app-tag--warning {
  background: var(--color-warning-bg);
  border-color: var(--color-warning-border);
  color: var(--color-warning-text);
}

.app-tag--danger {
  background: var(--color-danger-bg);
  border-color: var(--color-danger-border);
  color: var(--color-danger-text);
}

.app-tag--info {
  background: var(--color-accent-bg);
  border-color: var(--color-accent-border);
  color: var(--color-accent-text);
}

/* 只读档：抽掉底色、文字再淡一级，和「你自己打的标签」拉开份量 */
.app-tag--outline {
  background: transparent;
  border-color: var(--color-border-subtle);
  color: var(--color-text-muted);
}

.app-tag--dashed {
  background: transparent;
  border-style: dashed;
  border-color: var(--color-border);
  color: var(--color-text-muted);
}

/* 可点档 */
.app-tag--interactive {
  cursor: pointer;
  transition:
    background-color var(--motion-fast) var(--easing-standard),
    border-color var(--motion-fast) var(--easing-standard),
    color var(--motion-fast) var(--easing-standard);
}

.app-tag--interactive:hover {
  background: var(--color-accent-bg);
  border-color: var(--color-accent-border);
  color: var(--color-accent-text);
}

.app-tag--interactive:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}

/*
 * 选中 = 实色点缀，不加勾之类的指示。原来选中态用的是 accent-bg（深色下 #2b2b2b），
 * 和未选中的 surface-hover（#272727）只差一级明度，一屏几十个标签根本挑不出选了哪几个；
 * 这里用调色板里唯一那个高饱和色，中性底上只有它是彩的，扫一眼就分得开。
 *
 * 选中态**不许改变标签尺寸** —— 加个勾就多十几个像素，流式排布会跟着重新折行，
 * 点一个标签整片都在动。颜色变了、盒子没变，这是唯一不晃眼的做法。
 */
.app-tag--interactive.app-tag--selected {
  background: var(--color-accent-solid);
  border-color: var(--color-accent-solid);
  color: var(--color-text-on-solid);
}

.app-tag--interactive.app-tag--selected:hover {
  background: var(--color-accent-solid-hover);
  border-color: var(--color-accent-solid-hover);
  color: var(--color-text-on-solid);
}

/*
 * 选中态跟着 tone 走。资产筛选那边一个标签有三种状态：不管、包含、排除 ——
 * 「包含」和「排除」都是选中，只是方向相反。两个都染成同一个强调色的话，
 * 用户没法一眼看出哪几个是排除掉的；这里让 danger 档的选中态用危险实色，
 * 和包含的强调实色分开。**尺寸仍然一个像素都不变**，只换颜色。
 */
.app-tag--interactive.app-tag--selected.app-tag--danger {
  background: var(--color-danger-solid);
  border-color: var(--color-danger-solid);
  color: var(--color-text-on-solid);
}

.app-tag--interactive.app-tag--selected.app-tag--danger:hover {
  background: var(--color-danger-solid);
  border-color: var(--color-danger-solid);
  color: var(--color-text-on-solid);
  filter: brightness(1.1);
}

/* 删除按钮 */
.app-tag__remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: inherit;
  font-size: 11px;
  opacity: 0.6;
  cursor: pointer;
  transition:
    background-color var(--motion-fast) var(--easing-standard),
    color var(--motion-fast) var(--easing-standard),
    opacity var(--motion-fast) var(--easing-standard);
}

.app-tag:hover .app-tag__remove {
  opacity: 1;
}

.app-tag__remove:hover {
  background: var(--color-danger-bg);
  color: var(--color-danger-text);
}

.app-tag__remove:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 1px;
  opacity: 1;
}
</style>
