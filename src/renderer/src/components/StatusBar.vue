<template>
  <Transition name="slide-up">
    <div v-if="hasRunningTasks" class="status-bar">
      <div class="status-bar-content">
        <div v-for="task in runningTasks" :key="task.id" class="task-item">
          <PhCircleNotch class="task-icon spinning" />
          <span class="task-title">{{ task.title }}</span>
          <span class="task-progress">
            {{ task.current }}/{{ task.total }}
            <span v-if="task.total > 0" class="task-percent">
              ({{ Math.round((task.current / task.total) * 100) }}%)
            </span>
          </span>
          <span v-if="task.detail" class="task-detail">{{ task.detail }}</span>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { PhCircleNotch } from '@phosphor-icons/vue'
import { useBackgroundTaskStore } from '@/store/modules/backgroundTaskStore'

const backgroundTaskStore = useBackgroundTaskStore()
const { runningTasks, hasRunningTasks } = storeToRefs(backgroundTaskStore)
</script>

<style scoped lang="less">
.status-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 32px;
  background: linear-gradient(180deg, var(--color-bg-surface) 0%, var(--color-bg-surface) 100%);
  border-top: 1px solid var(--color-border-subtle);
  z-index: 1000;
  display: flex;
  align-items: center;
  padding: 0 16px;
  backdrop-filter: blur(8px);
}

.status-bar-content {
  display: flex;
  align-items: center;
  gap: 24px;
  width: 100%;
  overflow-x: auto;

  &::-webkit-scrollbar {
    display: none;
  }
}

.task-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--color-text-primary);
  white-space: nowrap;
}

.task-icon {
  color: var(--color-accent-text);
  font-size: 14px;

  &.spinning {
    animation: spin 1s linear infinite;
  }
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.task-title {
  font-weight: 500;
  color: var(--color-text-primary);
}

.task-progress {
  color: var(--color-accent-text);
  font-family: 'SF Mono', 'Monaco', monospace;
}

.task-percent {
  color: var(--color-text-primary);
  margin-left: 2px;
}

.task-detail {
  color: var(--color-text-primary);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}

// 过渡动画
.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.3s ease;
}

.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(100%);
  opacity: 0;
}
</style>
