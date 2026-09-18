<template>
  <AppButton
    class="change-toggle"
    variant="text"
    :disabled="!openReview"
    :title="change.path"
    @click="openReview?.(changes ?? [change], change.path)"
  >
    <span class="file-path">{{ change.path.split(/[\\/]/).pop() }}</span>
    <span class="added">+{{ added }}</span>
    <span class="removed">−{{ removed }}</span>
  </AppButton>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AppButton from '@renderer/components/AppButton.vue'
import { fileDiff, type FileChange } from '../../../../../shared/fileChange'
import { useFileReview } from '../composables/useFileReview'

const props = defineProps<{ change: FileChange; changes?: FileChange[] }>()
const openReview = useFileReview()
const rows = computed(() => fileDiff(props.change.before, props.change.after))
const added = computed(() => rows.value.filter((row) => row.kind === 'add').length)
const removed = computed(() => rows.value.filter((row) => row.kind === 'remove').length)
</script>

<style scoped>
.change-toggle {
  max-width: 100%;
}
.file-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.added {
  color: var(--color-success-text);
  margin-left: var(--space-2);
}
.removed {
  color: var(--color-danger-text);
  margin-inline: var(--space-2);
}
</style>
