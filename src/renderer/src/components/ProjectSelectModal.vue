<template>
  <AppModal
    v-model:open="visible"
    :title="$t('projectSelectModal.title')"
    :width="550"
    :mask-closable="false"
    @ok="handleOk"
    @cancel="handleCancel"
  >
    <div class="project-select-content">
      <p class="description">
        {{ $t('projectSelectModal.description', { path: directoryPath, count: projectCount }) }}
      </p>
      <div class="check-all-wrapper">
        <AppCheckbox
          :checked="checkAll"
          :indeterminate="indeterminate"
          @change="handleCheckAllChange"
        >
          {{ $t('projectSelectModal.selectAll') }}
        </AppCheckbox>
      </div>
      <div class="project-list">
        <div v-for="project in projectList" :key="project.filePath" class="project-item">
          <AppCheckbox
            :checked="selectedProjects.has(project.filePath)"
            @change="(checked) => handleItemChange(project.filePath, checked)"
          >
            {{ project.name }}
          </AppCheckbox>
        </div>
      </div>
    </div>
    <template #footer>
      <AppButton @click="handleCancel">{{ $t('projectSelectModal.cancel') }}</AppButton>
      <AppButton variant="primary" @click="handleOk">
        {{ $t('projectSelectModal.importSelected', { count: selectedProjects.size }) }}
      </AppButton>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
import AppModal from '@renderer/components/AppModal.vue'
import AppCheckbox from '@renderer/components/AppCheckbox.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { ref, computed, watch } from 'vue'

interface ProjectItem {
  filePath: string
  name: string
}

interface Props {
  open: boolean
  directoryPath: string
  projectList: ProjectItem[]
}

interface Emits {
  (e: 'update:open', value: boolean): void
  (e: 'confirm', selectedFiles: string[]): void
  (e: 'cancel'): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const visible = computed({
  get: () => props.open,
  set: (value) => emit('update:open', value)
})

const projectCount = computed(() => props.projectList.length)

// 选中状态
const selectedProjects = ref<Set<string>>(new Set())

// 全选状态
const checkAll = computed(() => selectedProjects.value.size === projectCount.value)
const indeterminate = computed(
  () => selectedProjects.value.size > 0 && selectedProjects.value.size < projectCount.value
)

// 监听打开状态，初始化选中项
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      // 默认全选
      selectedProjects.value = new Set(props.projectList.map((p) => p.filePath))
    } else {
      selectedProjects.value = new Set()
    }
  },
  { immediate: true }
)

// 全选/取消全选
const handleCheckAllChange = (checked: boolean): void => {
  if (checked) {
    selectedProjects.value = new Set(props.projectList.map((p) => p.filePath))
  } else {
    selectedProjects.value = new Set()
  }
}

// 单个复选框变化
const handleItemChange = (filePath: string, checked: boolean) => {
  const newSet = new Set(selectedProjects.value)
  if (checked) {
    newSet.add(filePath)
  } else {
    newSet.delete(filePath)
  }
  selectedProjects.value = newSet
}

// 确定
const handleOk = () => {
  const selectedFiles = Array.from(selectedProjects.value)
  if (selectedFiles.length === 0) {
    return
  }
  emit('confirm', selectedFiles)
  visible.value = false
}

// 取消
const handleCancel = () => {
  emit('cancel')
  visible.value = false
}
</script>

<style scoped lang="less">
.project-select-content {
  .description {
    margin-bottom: 12px;
    font-weight: 500;
    color: var(--color-text-primary);
  }

  .check-all-wrapper {
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--color-border-subtle);
  }

  .project-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 250px;
    overflow-y: auto;

    .project-item {
      display: flex;
      align-items: center;
      color: var(--color-text-primary);
    }
  }
}
</style>
