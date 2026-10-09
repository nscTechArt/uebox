<template>
  <div class="top-nav">
    <!-- 左侧标题区域：仅在知识库模式下显示 -->
    <div v-if="notebookMode" class="left">
      <span class="notebook-title">{{ t('notebook.detail.chatWithKnowledge') }}</span>
    </div>
    <div class="right">
      <!--
        这条会话属于哪个 UE 工程。知识库里用的是**同一个** —— 知识库原来另有一套
        「关联工程」（存在 notebook 表上），那套只改了这里的显示，从来没有传进
        主进程，也就从来没有真的把 ue.* 工具指向那个工程。留着两套的结果是
        用户以为绑了、模型那边毫无变化。
      -->
      <!-- 状态监控放在工程胶囊左边；欢迎页把胶囊挪走了，它照样留在顶栏 -->
      <EditorStatusMonitor :session-id="sessionId" :pending-project-name="pendingProjectName" />
      <SessionProjectChip
        v-if="!hideProjectChip"
        :session-id="sessionId"
        :pending-project-name="pendingProjectName"
      />
      <AppDropdown :trigger="['click']">
        <span class="more-btn" @click.stop>
          <PhDotsThree class="more" />
        </span>
        <template #overlay>
          <AppMenu>
            <!--
              侧边问一句：把当前上下文复制给小窗口，在那边只读地问。
              **跑着的时候也能开** —— 那正是最想问「它现在在干嘛」的时刻
            -->
            <AppMenuItem @click="emitSideQuestion">
              {{ t('assistant.sideQuestion.open') }}
            </AppMenuItem>
            <AppMenuItem @click="emitClear"> {{ t('assistant.topNav.clearChat') }} </AppMenuItem>
            <AppMenuItem @click="emitExportImage">
              {{ t('assistant.topNav.exportImage') }}
            </AppMenuItem>
            <AppMenuItem @click="emitExportJSON">
              {{ t('assistant.topNav.exportJSON') }}
            </AppMenuItem>
            <AppMenuItem @click="emitExportMarkdown">
              {{ t('assistant.topNav.exportMarkdown') }}
            </AppMenuItem>
          </AppMenu>
        </template>
      </AppDropdown>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import { PhDotsThree } from '@phosphor-icons/vue'
import { useI18n } from 'vue-i18n'
import SessionProjectChip from './SessionProjectChip.vue'
import EditorStatusMonitor from './EditorStatusMonitor.vue'

/**
 * TopNav 组件属性
 * @prop notebookMode - 是否为知识库模式，为 true 时左侧显示"与知识库对话"标题
 */
defineProps<{
  notebookMode?: boolean
  /** 当前会话 ID，用于在右上角显示这条会话属于哪个 UE 工程 */
  sessionId?: string
  /** 会话还没建出来时的待定工程归属（侧边栏在工程标题上点「+」新建的会话） */
  pendingProjectName?: string
  /** 欢迎页把工程胶囊挪到问候语下面，顶栏就不再重复放一个 */
  hideProjectChip?: boolean
}>()

const emit = defineEmits<{
  (e: 'side-question'): void
  (e: 'clear'): void
  (e: 'export-image'): void
  (e: 'export-json'): void
  (e: 'export-md'): void
}>()

const { t } = useI18n()

/** 更多菜单点了「侧边问一句」：只把事件发出去，复制上下文和开小窗由 Welcome 处理 */
function emitSideQuestion(): void {
  emit('side-question')
}

function emitClear(): void {
  emit('clear')
}

function emitExportImage(): void {
  emit('export-image')
}

function emitExportJSON(): void {
  emit('export-json')
}

function emitExportMarkdown(): void {
  emit('export-md')
}
</script>

<style scoped lang="less">
.top-nav {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 24px;
  color: var(--color-text-primary);
}

.left {
  display: flex;
  align-items: center;
  gap: 12px;

  .notebook-title {
    font-size: 15px;
    font-weight: 500;
    color: var(--color-text-primary);
  }
}

.right {
  // 非知识库模式下左侧那块是 v-if 掉的，只靠 space-between 会把这组挤到最左边
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 12px;
  cursor: default;

  .more {
    font-size: 16px;
  }
}

.more-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
}
</style>
