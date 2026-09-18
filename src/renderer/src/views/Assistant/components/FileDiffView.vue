<template>
  <div class="file-change">
    <AppButton
      class="change-toggle"
      variant="text"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span class="file-path" :title="change.path">{{ change.path }}</span>
      <span class="added">+{{ added }}</span>
      <span class="removed">−{{ removed }}</span>
      <span>{{ t(expanded ? 'assistant.fileDiff.hide' : 'assistant.fileDiff.show') }}</span>
    </AppButton>
    <div v-if="expanded" class="diff-body">
      <p v-if="!added && !removed">{{ t('assistant.fileDiff.unchanged') }}</p>
      <template v-for="(row, index) in visibleRows.slice(0, limit)" :key="index">
        <div v-if="row === null" class="fold">{{ t('assistant.fileDiff.folded') }}</div>
        <div v-else class="diff-line" :class="row.kind">
          <span class="line-number">{{ row.oldLine }}</span>
          <span class="line-number">{{ row.newLine }}</span>
          <span>{{ row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' ' }}</span>
          <code
            >{{ row.text.replace(/\r?\n$/, '')
            }}<span v-if="!row.text.endsWith('\n')" class="eof">
              {{ t('assistant.fileDiff.noNewline') }}</span
            ></code
          >
        </div>
      </template>
      <AppButton v-if="visibleRows.length > limit" variant="text" @click="limit += 200">
        {{ t('assistant.fileDiff.more') }}
      </AppButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppButton from '@renderer/components/AppButton.vue'
import { fileDiff, type FileChange, type DiffLine } from '../../../../../shared/fileChange'

const props = defineProps<{ change: FileChange }>()
const { t } = useI18n()
const expanded = ref(true)
const limit = ref(200)
const rows = computed(() => fileDiff(props.change.before, props.change.after))
const added = computed(() => rows.value.filter((row) => row.kind === 'add').length)
const removed = computed(() => rows.value.filter((row) => row.kind === 'remove').length)
const visibleRows = computed(() => {
  const result: (DiffLine | null)[] = []
  const changed = new Set<number>()
  rows.value.forEach((row, index) => {
    if (row.kind !== 'same') {
      for (let i = Math.max(0, index - 3); i <= index + 3; i++) changed.add(i)
    }
  })
  rows.value.forEach((row, index) => {
    if (changed.has(index)) result.push(row)
    else if (result[result.length - 1] !== null) result.push(null)
  })
  return result
})
</script>

<style scoped>
.file-change {
  border-bottom: 1px solid var(--color-border);
  overflow: hidden;
}
.change-toggle {
  width: 100%;
  justify-content: flex-start;
  gap: var(--space-2);
}
.file-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.added,
.add {
  color: var(--color-success-text);
}
.added {
  margin-left: var(--space-2);
}
.removed {
  margin-inline: var(--space-2);
}
.removed,
.remove {
  color: var(--color-danger-text);
}
.add {
  background: var(--color-success-bg);
}
.remove {
  background: var(--color-danger-bg);
}
.diff-body {
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
}
.diff-line {
  display: flex;
  gap: var(--space-2);
  padding-inline: var(--space-2);
  min-width: max-content;
  white-space: pre;
}
.line-number {
  min-width: 4ch;
  text-align: right;
  color: var(--color-text-muted);
  user-select: none;
}
.fold,
.eof {
  color: var(--color-text-muted);
  padding: var(--space-1) var(--space-2);
}
code {
  font: inherit;
}
</style>
