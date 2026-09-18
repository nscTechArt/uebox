<template>
  <section class="file-review" :aria-label="t('assistant.fileDiff.review')">
    <header class="review-summary">
      <span>{{ t('assistant.changes.fileCount', { count: fileCount }) }}</span>
      <span class="added">+{{ added }}</span>
      <span class="removed">−{{ removed }}</span>
    </header>
    <div ref="scrollArea" class="review-files">
      <div v-for="(change, index) in changes" :key="index" :data-file-path="change.path">
        <FileDiffView :change="change" />
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { fileDiff, type FileChange } from '../../../../../shared/fileChange'
import FileDiffView from './FileDiffView.vue'

const props = defineProps<{ changes: FileChange[]; selectedPath: string }>()
const { t } = useI18n()
const scrollArea = ref<HTMLElement | null>(null)
const fileCount = computed(() => new Set(props.changes.map((change) => change.path)).size)
const rows = computed(() =>
  props.changes.flatMap((change) => fileDiff(change.before, change.after))
)
const added = computed(() => rows.value.filter((row) => row.kind === 'add').length)
const removed = computed(() => rows.value.filter((row) => row.kind === 'remove').length)
watch(
  () => [props.changes, props.selectedPath],
  async () => {
    await nextTick()
    const target = Array.from(scrollArea.value?.children ?? []).find(
      (element) => (element as HTMLElement).dataset.filePath === props.selectedPath
    ) as HTMLElement | undefined
    if (scrollArea.value && target)
      scrollArea.value.scrollTop = target.offsetTop - scrollArea.value.offsetTop
  },
  { immediate: true }
)
</script>

<style scoped>
.file-review {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--color-text-primary);
}
.review-summary {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-3);
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--font-size-sm);
}
.review-files {
  flex: 1;
  min-height: 0;
  overflow: auto;
  position: relative;
}
.added {
  color: var(--color-success-text);
}
.removed {
  color: var(--color-danger-text);
}
</style>
