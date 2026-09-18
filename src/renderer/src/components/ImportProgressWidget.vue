<template>
  <div v-if="tasks.length > 0" class="import-progress-widget">
    <button
      type="button"
      class="widget-header"
      :aria-expanded="!collapsed"
      @click="collapsed = !collapsed"
    >
      <!--
        全是失败任务时不许再转圈：什么都没在跑，转圈就是在骗人。
        失败的任务现在会一直留在列表里等用户看过，所以这个判断必须有。
      -->
      <component
        :is="headerIcon"
        class="loading-icon"
        :class="{ spinning: hasRunning }"
        weight="bold"
      />
      <span class="title">
        {{
          hasRunning
            ? $t('importProgressWidget.title', { count: tasks.length })
            : $t('importProgressWidget.titleFailed', { count: tasks.length })
        }}
      </span>
      <PhCaretDown class="caret" :class="{ rotated: !collapsed }" />
    </button>

    <div v-show="!collapsed" class="task-list">
      <div
        v-for="task in tasks"
        :key="task.id"
        class="task-item"
        :class="{ clickable: Boolean(task.folderKey) }"
        @click="handleTaskClick(task)"
      >
        <!-- 第一行：名字 + 百分比 + 中止 -->
        <div class="task-headline">
          <component :is="taskIcon(task)" class="task-icon" :class="accentClass(task)" />
          <span class="task-name" :title="task.name">{{ task.name }}</span>
          <span class="task-percent" :class="accentClass(task)">
            {{ Math.round(task.progress || 0) }}%
          </span>
          <!-- 几万个文件的导入必须能叫停，否则只能杀进程 -->
          <button
            v-if="task.cancellable && task.status !== 'completed' && task.status !== 'error'"
            type="button"
            class="cancel-button"
            :title="$t('importProgressWidget.cancel')"
            :aria-label="$t('importProgressWidget.cancel')"
            @click.stop="emit('cancel', task.id)"
          >
            <PhX weight="bold" />
          </button>
          <!-- 失败了就换成「关掉」：这时候没什么可叫停的，但这条得留到用户看过为止 -->
          <button
            v-else-if="task.status === 'error'"
            type="button"
            class="cancel-button"
            :title="$t('importProgressWidget.dismiss')"
            :aria-label="$t('importProgressWidget.dismiss')"
            @click.stop="emit('dismiss', task.id)"
          >
            <PhX weight="bold" />
          </button>
        </div>

        <!-- 第二行：去向 + 模式徽标，一行放不下就省略 -->
        <div v-if="hasMeta(task)" class="task-meta">
          <span class="meta-target" :title="targetLabel(task)">{{ targetLabel(task) }}</span>
          <span v-if="task.importMode" class="mode-badge" :class="`mode-${task.importMode}`">
            {{ modeLabel(task.importMode) || $t('importProgressWidget.detecting') }}
          </span>
          <span v-if="task.sessionId" class="session-id" :title="task.sessionId">
            {{ task.sessionId.substring(0, 8) }}
          </span>
        </div>

        <AppProgress
          :percent="task.progress || 0"
          size="small"
          :status="progressStatus(task)"
          :show-info="false"
        />

        <div class="task-stage" :title="task.stageText">
          {{ task.stageText || $t('importProgressWidget.inProgress') }}
        </div>

        <!--
          失败之后的下一层入口。

          没有它的时候，用户拿到的最深信息就是一句「导入完成，7 条警告」——
          缺的是什么、要不要去保管库补、能不能只导没问题的，一概不知道。
        -->
        <button
          v-if="task.status === 'error' && task.report"
          type="button"
          class="detail-button"
          @click.stop="emit('inspect', task.id)"
        >
          {{ $t('importProgressWidget.viewDetail') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, type Component } from 'vue'
import {
  PhCaretDown,
  PhCircleNotch,
  PhFolderOpen,
  PhSquaresFour,
  PhWarningCircle,
  PhX
} from '@phosphor-icons/vue'
import type { ImportFailureReport } from '@core/shared/projectImport'
import AppProgress from './AppProgress.vue'

interface ImportTask {
  id: string
  name: string
  progress: number
  stageText?: string
  status?: string
  folderKey?: string
  folderName?: string
  /** 任务类型：导入到资产库 或 导入到工程 */
  taskType?: 'vault-import' | 'project-import'
  /** 目标工程名称（仅 project-import 类型使用） */
  projectName?: string
  /** 远程导入模式 */
  importMode?: 'v2-session' | 'v1-batch' | 'detecting'
  /** V2 会话 ID */
  sessionId?: string
  /** 这个任务能不能中途叫停 */
  cancellable?: boolean
  /** 出了什么问题、影响了谁。有它才给「查看详情」 */
  report?: ImportFailureReport
}

const props = defineProps<{
  tasks: ImportTask[]
}>()

const emit = defineEmits<{
  (e: 'navigate', folderKey: string): void
  (e: 'cancel', taskId: string): void
  /** 打开这条任务的失败详情 */
  (e: 'inspect', taskId: string): void
  /** 用户看过了，把这条失败任务从挂件上收掉 */
  (e: 'dismiss', taskId: string): void
}>()

const collapsed = ref(false)

/** 还有活在跑吗。全是失败的残留时，标题和图标都得改口 */
const hasRunning = computed(() => props.tasks.some((task) => task.status !== 'error'))
const headerIcon = computed(() => (hasRunning.value ? PhCircleNotch : PhWarningCircle))

const isProjectImport = (task: ImportTask): boolean => task.taskType === 'project-import'

/** 工程导入用绿色，导入资产库用强调色，出错用危险色 */
const accentClass = (task: ImportTask): string => {
  if (task.status === 'error') return 'is-error'
  return isProjectImport(task) ? 'is-project' : 'is-vault'
}

const progressStatus = (task: ImportTask): 'active' | 'success' | 'exception' => {
  if (task.status === 'error') return 'exception'
  if (task.status === 'completed' || task.progress >= 100) return 'success'
  return 'active'
}

const taskIcon = (task: ImportTask): Component =>
  isProjectImport(task) ? PhSquaresFour : PhFolderOpen

/** 这个任务的东西要去哪儿：工程导入报工程名，资产库导入报目标文件夹 */
const targetLabel = (task: ImportTask): string =>
  (isProjectImport(task) ? task.projectName : task.folderName) || ''

const hasMeta = (task: ImportTask): boolean =>
  Boolean(targetLabel(task) || task.importMode || task.sessionId)

/** 检测中没有短代号，返回空串让模板去取译文 */
const modeLabel = (mode: NonNullable<ImportTask['importMode']>): string => {
  if (mode === 'v2-session') return 'V2'
  if (mode === 'v1-batch') return 'V1'
  return ''
}

const handleTaskClick = (task: ImportTask): void => {
  if (task.folderKey) emit('navigate', task.folderKey)
}
</script>

<style lang="less" scoped>
.import-progress-widget {
  position: fixed;
  bottom: var(--space-6);
  /*
   * 让开右下角那条悬浮按钮的通道（资产库的上传 / 恢复导入 FAB 就在 right: 24px）。
   * 挂件现在是常驻的，压在上面等于导入期间那几个按钮点不了。
   */
  right: var(--space-6);
  width: 320px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-container);
  box-shadow: 0 8px 24px var(--shadow-color);
  z-index: 1000;
  overflow: hidden;
  backdrop-filter: blur(20px);
}

.widget-header {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: none;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
  cursor: pointer;
  user-select: none;
  text-align: left;
  font: inherit;

  .loading-icon {
    flex-shrink: 0;
    font-size: var(--font-size-base);
    color: var(--color-accent-text);

    &.spinning {
      animation: import-widget-spin 1.1s linear infinite;
    }
  }

  .title {
    flex: 1;
    min-width: 0;
    font-size: var(--font-size-sm);
    font-weight: 600;
  }

  .caret {
    flex-shrink: 0;
    color: var(--color-text-muted);
    transition: transform 0.2s;

    &.rotated {
      transform: rotate(180deg);
    }
  }
}

.task-list {
  max-height: 320px;
  overflow-y: auto;

  &::-webkit-scrollbar {
    width: 4px;
  }
  &::-webkit-scrollbar-thumb {
    background: var(--color-border-strong);
    border-radius: 2px;
  }
}

/*
 * 每个任务是一张竖排的小卡：标题行 / 去向 / 进度条 / 状态文字。
 *
 * 原来是「文字压在一条背景色进度条上」，加上状态文字被塞进右侧一个
 * flex-direction: column 的窄栏里 —— 长句子没有省略、和左边的名字抢宽度，
 * 排版就散了。现在每一行各管一件事，宽度也各自收敛。
 */
.task-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-border-subtle);

  &:last-child {
    border-bottom: none;
  }

  &.clickable {
    cursor: pointer;

    &:hover {
      background: var(--color-bg-surface-hover);
    }
  }
}

.task-headline {
  display: flex;
  align-items: center;
  gap: var(--space-2);

  .task-icon {
    flex-shrink: 0;
    font-size: var(--font-size-base);
  }

  .task-name {
    flex: 1;
    min-width: 0;
    font-size: var(--font-size-sm);
    font-weight: 500;
    color: var(--color-text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .task-percent {
    flex-shrink: 0;
    font-size: var(--font-size-sm);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    font-family: var(--font-family-mono, monospace);
  }
}

.task-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);

  .meta-target {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

/* 状态文字带字节数和文件数，一行放不下就省略，不许换行把卡片撑高 */
.task-stage {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.detail-button {
  align-self: flex-start;
  margin-top: var(--space-1);
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  font-size: var(--font-size-xs);
  color: var(--color-danger-text);
  text-decoration: underline;
  text-underline-offset: 2px;

  &:hover {
    opacity: 0.8;
  }
}

.mode-badge {
  flex-shrink: 0;
  padding: 1px var(--space-1);
  border-radius: var(--radius-xs);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  line-height: 1.4;
  font-family: var(--font-family-mono, monospace);

  &.mode-v2-session {
    background: var(--color-success-bg);
    color: var(--color-success-text);
    border: 1px solid var(--color-success-border);
  }

  &.mode-v1-batch {
    background: var(--color-warning-bg);
    color: var(--color-warning-text);
    border: 1px solid var(--color-warning-border);
  }

  &.mode-detecting {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border-strong);
  }
}

.session-id {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--color-text-muted);
  font-family: var(--font-family-mono, monospace);
}

.cancel-button {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-1);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: var(--font-size-sm);
  line-height: 1;
  transition:
    background 0.2s,
    color 0.2s;

  &:hover {
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
  }
}

.is-project {
  color: var(--color-success-text);
}

.is-vault {
  color: var(--color-accent-text);
}

.is-error {
  color: var(--color-danger-text);
}

@keyframes import-widget-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
