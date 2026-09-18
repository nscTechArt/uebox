<script setup lang="ts">
/**
 * 蓝图编辑器 / 材质编辑器共用的顶栏。
 *
 * 两行式：第一行是「返回 · 名称 · 若干标签」，第二行是一句次要信息
 * （材质放资产路径，蓝图放描述）。之前蓝图那边是单行，信息密度撑不满，
 * 材质那边已经是两行 —— 统一成两行。
 *
 * 标签与右侧动作按钮由调用方给（两个库的元信息不一样），外观在这里统一：
 * 用 `.topbar-chip` 和 `.topbar-action` 这两个类名即可。
 */
withDefaults(
  defineProps<{
    /** 返回按钮文案 */
    backLabel: string
    /** 主标题：蓝图 / 材质的名字 */
    name: string
    /** 第二行文案，没有就不占位 */
    subtitle?: string
    /** 第二行的 tooltip */
    subtitleTitle?: string
    /** 第二行是否可点（材质用来复制资产路径） */
    subtitleClickable?: boolean
  }>(),
  { subtitle: '', subtitleTitle: '', subtitleClickable: false }
)

const emit = defineEmits<{ back: []; 'subtitle-click': [] }>()
</script>

<template>
  <div class="editor-topbar">
    <button class="back-btn" @click="emit('back')">← {{ backLabel }}</button>

    <div class="title-block">
      <div class="title-row">
        <span class="entry-name">{{ name }}</span>
        <slot name="chips" />
      </div>
      <button
        v-if="subtitle"
        type="button"
        class="title-sub"
        :class="{ clickable: subtitleClickable }"
        :title="subtitleTitle || subtitle"
        :disabled="!subtitleClickable"
        @click="emit('subtitle-click')"
      >
        {{ subtitle }}
      </button>
    </div>

    <div class="topbar-spacer" />

    <slot name="actions" />
  </div>
</template>

<style scoped lang="less">
.editor-topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px var(--space-4);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-surface);
  flex-shrink: 0;
}

// 尺寸和描边跟 AppButton 默认款一致（32px、--radius-md、--color-border）
.back-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    background: var(--color-bg-surface-hover);
    border-color: var(--color-border-strong);
    color: var(--color-text-primary);
  }
}

.title-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.title-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.entry-name {
  font-size: 15px;
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
}

.title-sub {
  max-width: 500px;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
  transition: color 0.15s;

  &.clickable {
    cursor: pointer;

    &:hover {
      color: var(--color-text-muted);
    }
  }
}

.topbar-spacer {
  flex: 1;
}

// ===== 插槽内容的统一外观 =====
.editor-topbar :deep(.topbar-chip) {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--color-bg-surface-hover);
  white-space: nowrap;

  &.status-success {
    background: var(--color-success-bg);
    color: var(--color-success-text);
  }

  &.status-warning {
    background: var(--color-warning-bg);
    color: var(--color-warning-text);
  }

  &.status-error {
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
  }
}

.editor-topbar :deep(.topbar-action) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;

  &:hover {
    background: var(--color-bg-surface-hover);
    border-color: var(--color-border-strong);
    color: var(--color-text-primary);
  }

  &.active {
    background: var(--color-bg-selected);
    color: var(--color-text-selected);
  }

  &.is-favorite {
    color: var(--color-warning-text);
    border-color: var(--color-warning-border);
  }
}
</style>
