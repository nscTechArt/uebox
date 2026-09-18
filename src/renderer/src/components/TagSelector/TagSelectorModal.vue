<template>
  <AppModal
    v-model:open="innerOpen"
    :width="720"
    :mask-closable="false"
    hide-footer
    :destroy-on-close="true"
    :closable="false"
    centered
    class="tag-selector-modal-wrapper"
  >
    <div class="tag-selector-container">
      <TagSelectorList
        v-if="innerOpen"
        v-model:selected-ids="selectedIds"
        @close="handleCancel"
        @confirm="handleOk"
      />
    </div>
  </AppModal>
</template>

<script setup lang="ts">
import AppModal from '@renderer/components/AppModal.vue'
import { ref, computed, watch } from 'vue'
import TagSelectorList from '@renderer/components/TagSelector/TagSelectorList.vue'

// 保留原有 SimpleTag 定义（如有需要可移除）
// interface SimpleTag { id: number; name: string; color?: string }

const props = defineProps<{ open: boolean; initialSelectedTagIds?: number[] }>()
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'confirm', value: number[]): void
}>()

const innerOpen = computed({
  get: () => props.open,
  set: (val: boolean) => emit('update:open', val)
})

// 从子组件接收/维护选中标签
const selectedIds = ref<number[]>([])

// 打开时初始化选中，关闭时清空
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      selectedIds.value = [...(props.initialSelectedTagIds || [])]
    } else {
      selectedIds.value = []
    }
  }
)

const handleOk = (): void => {
  emit('confirm', selectedIds.value)
  emit('update:open', false)
}

const handleCancel = (): void => {
  emit('update:open', false)
}
</script>

<style lang="less">
/*
 * 全局模态框样式。内容是通版到边的（头部、侧栏、底栏各有底色），所以清掉
 * body 的默认内边距；圆角、阴影、底色交给 AppModal 自己的面板 —— 以前这里
 * 把 box-shadow 抹成 none、又在 .modal-container 里重画一遍边框和阴影。
 */
.tag-selector-modal-wrapper {
  .app-modal__panel {
    padding: 0;
    background: var(--color-bg-surface);
    /* 面板带圆角，内部的底色块必须裁掉四角 */
    overflow: hidden;
  }

  .app-modal__body {
    padding: 0;
  }
}
</style>

<style scoped lang="less">
/* 高度交给里面的 .modal-container 按内容决定，这里不再写死 650px */
.tag-selector-container {
  width: 100%;
  overflow: hidden;
}
</style>
