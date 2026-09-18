<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import AppModal from '@renderer/components/AppModal.vue'
/**
 * 归档对话
 *
 * 归档区原来常年挂在侧边栏最底下的一个折叠标题里：天天要看的会话列表下面
 * 压着一块永远收起来的东西，占位、也提示不了任何信息。这里是它现在唯一的
 * 入口 —— 归档就是「收起来不看了」，需要的时候来偏好设置找回或者彻底删掉。
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { confirmDialog } from '@renderer/utils/dialog'
import { useI18n } from 'vue-i18n'
import { PhArchive, PhTrash } from '@phosphor-icons/vue'
import { message } from '@renderer/utils/messageManager'
import { useChatSessionsStore, type ChatSession } from '@renderer/store/modules/chatSessions'
import { useChatMessagesStore } from '@renderer/store/modules/chatMessages'
import { useTabsStore } from '@renderer/store/modules/tabs'
import { deleteChatSession } from '@renderer/composables/deleteChatSession'
import { chatSessionRoute } from '@renderer/common/chatRoute'

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
}>()

const { t, locale } = useI18n()
const router = useRouter()
const chatStore = useChatSessionsStore()
const chatMsgStore = useChatMessagesStore()
const tabsStore = useTabsStore()

/**
 * 最近归档的排最前。
 *
 * 按 `archivedAt` 而不是 `updatedAt`：这一屏回答的是「我什么时候把它收起来的」，
 * 不是「它最后一次说话是什么时候」。老会话没有这个字段，退回 updatedAt。
 */
const sessions = computed<ChatSession[]>(() =>
  [...chatStore.archivedSessions].sort(
    (left, right) => (right.archivedAt || right.updatedAt) - (left.archivedAt || left.updatedAt)
  )
)

function formatDate(timestamp?: number): string {
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleString(locale.value, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function closeModal(): void {
  emit('update:visible', false)
}

/** 取消归档：会话立刻回到侧边栏的「对话」或它原来的工程下 */
function unarchive(session: ChatSession): void {
  chatStore.setArchived(session.id, false)
}

/**
 * 打开这条会话 —— 不改归档状态，只是去看看。
 *
 * 已经开着的标签页就切过去，否则新开一个，和侧边栏点会话是同一个走法
 * （见 SideMenu 的 openChat）。
 */
function openChat(session: ChatSession): void {
  closeModal()
  void router.push(
    chatSessionRoute(
      session.id,
      tabsStore.historyTabs.map((tab) => tab.path)
    )
  )
}

/**
 * 删除会话。
 *
 * 和侧边栏走同一条 `deleteChatSession`：气泡、会话本身、内核记忆三处一起清，
 * 只从列表里划掉不算删干净。
 */
function handleDelete(session: ChatSession): void {
  confirmDialog({
    title: t('chatSidebar.deleteTitle'),
    content: t('chatSidebar.deleteContent', { title: session.title }),
    okText: t('chatSidebar.delete'),
    cancelText: t('chatSidebar.cancel'),
    danger: true,
    async onOk() {
      const result = await deleteChatSession({
        sessionId: session.id,
        agentSessionId: session.agentSessionId,
        deleteTranscript: (sessionId) => window.api.agentV3.deleteSession({ sessionId }),
        dropMessages: (id) => chatMsgStore.dropSession(id),
        removeSession: (id) => chatStore.removeSession(id),
        listTabs: () => tabsStore.historyTabs.map((tab) => ({ key: tab.key, path: tab.path })),
        closeTab: (key) => tabsStore.removeTab(key)
      })

      // 盘上没删干净必须说出来，不然用户以为隐私数据已经没了
      if (result.transcriptError) {
        message.warning(t('chatSidebar.deleteTranscriptFailed', { error: result.transcriptError }))
      }
    }
  })
}
</script>

<template>
  <AppModal
    :open="props.visible"
    hide-footer
    :title="t('archivedChats.title')"
    width="720px"
    @cancel="closeModal"
  >
    <div class="archived-head">
      <span class="archived-desc">{{ t('archivedChats.description') }}</span>
      <span class="archived-count">{{ t('archivedChats.count', { count: sessions.length }) }}</span>
    </div>

    <div class="archived-list">
      <div v-for="session in sessions" :key="session.id" class="archived-item">
        <div class="archived-info">
          <div class="archived-title">{{ session.title }}</div>
          <div class="archived-meta">
            <span v-if="session.project?.projectName" class="archived-project">
              {{ session.project.projectName }}
            </span>
            <span v-if="session.archivedAt">
              {{ t('archivedChats.archivedAt', { date: formatDate(session.archivedAt) }) }}
            </span>
          </div>
        </div>

        <div class="archived-actions">
          <AppButton variant="soft" size="medium" @click="openChat(session)">
            {{ t('archivedChats.open') }}
          </AppButton>
          <AppButton variant="soft" size="medium" @click="unarchive(session)">
            <template #icon><PhArchive /></template>
            {{ t('chatSidebar.unarchive') }}
          </AppButton>
          <AppButton
            variant="soft"
            size="medium"
            danger
            :aria-label="t('chatSidebar.delete')"
            @click="handleDelete(session)"
          >
            <template #icon><PhTrash /></template>
          </AppButton>
        </div>
      </div>

      <div v-if="sessions.length === 0" class="archived-empty">
        {{ t('archivedChats.empty') }}
      </div>
    </div>
  </AppModal>
</template>

<style scoped lang="less">
.archived-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--color-border-subtle);
}

.archived-desc {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.archived-count {
  flex: none;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.archived-list {
  max-height: 420px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.archived-item {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);

  &:hover {
    background: var(--color-bg-surface-hover);
  }
}

.archived-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.archived-title {
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.archived-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.archived-project {
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  background: var(--color-bg-surface-hover);
}

.archived-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.archived-empty {
  padding: var(--space-8) 0;
  text-align: center;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}
</style>
