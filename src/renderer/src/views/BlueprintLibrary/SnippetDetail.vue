<script setup lang="ts">
/**
 * 片段条目的详情页。
 *
 * ## 这里还没有图
 *
 * 给的是摘要：节点数、连线数、用到的节点类型、悬空端口。
 * 够用户认出「这段是什么」，也够他决定要不要放进当前工程。
 *
 * **为什么不接那个现成的渲染器。** 2026-09-16 片段改存 T3D（和老条目同一种
 * 文本）之后，老条目那个第三方渲染器 `ueblueprint.js` 读得了这段正文 ——
 * 一度以为「接上去是一件小事」，实际不是：那个组件是个**编辑器**，
 * 拖节点、改连线都会改内容，而片段没有地方存这些改动（写回包目录是另一条
 * 主进程通路）。接上去的结果是用户拖了两下、换个页面回来全没了 ——
 * 比一个老实的摘要页更糟。要接得先给渲染器一个真正的只读模式，那是正经活。
 *
 * ## 但 AI 面板接上了
 *
 * 右边嵌的就是主助手，和老条目那边同一个组件。片段的正文（T3D）会作为
 * 上下文给它 —— 所以「这段是干嘛的」「放进哪个蓝图合适」它答得上来，
 * 而且答完可以直接动手放。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import AppButton from '@renderer/components/AppButton.vue'
import LibraryEditorTopbar from '@renderer/views/library-common/components/LibraryEditorTopbar.vue'
import LibraryAIPanel from '@renderer/views/library-common/components/LibraryAIPanel.vue'
import type { LibraryChatContext } from '@renderer/views/Assistant/composables/libraryChatContext'
import type { AIPanelMode } from '@renderer/views/library-common/types'
import {
  readSnippetPayload,
  summarizeSnippet,
  type SnippetPayload
} from '@renderer/views/library-common/utils/snippetForm'

const props = withDefaults(
  defineProps<{
    /** 条目名 */
    name: string
    /** 整个 payload，由调用方从条目上取 */
    payload: unknown
    /** 条目 id，AI 会话跟着它走 */
    entryId: string
    /** 「放进当前工程」正在跑 */
    applying?: boolean
    aiPanelMode?: AIPanelMode
  }>(),
  { aiPanelMode: 'docked' }
)

const emit = defineEmits<{
  back: []
  apply: []
  'update:aiPanelMode': [mode: AIPanelMode]
  restoreAiPanel: []
}>()

const { t } = useI18n()

const snippet = computed<SnippetPayload | null>(() => readSnippetPayload(props.payload))
const summary = computed(() => (snippet.value ? summarizeSnippet(snippet.value) : null))

/** 正文最多往上下文里塞多少。一段片段通常几千字符，整段带得起 */
const T3D_CONTEXT_LIMIT = 12000

/**
 * 交给助手的上下文。
 *
 * 和老条目那边最大的不同是**带正文** —— 片段的全部内容就是那段 T3D，
 * 不给的话助手只能对着「5 个节点、用到 Branch」这种摘要猜。
 * 给了它就能逐节点讲清楚这段在干什么。
 */
const chatContext = computed<LibraryChatContext | null>(() => {
  const current = snippet.value
  if (!current || !props.entryId) return null

  const meta = current.meta
  const overviewLines = [
    '这是库里的一个**蓝图片段**（从某个工程里圈选一段存下来的，扫过外部依赖）。',
    `节点 ${meta.nodeCount} / 连线 ${meta.connectionCount} / 悬空端口 ${meta.openPorts.length}`,
    meta.classes.length ? `用到的节点类型：${meta.classes.join('、')}` : '',
    current.sourceBlueprintPath
      ? `来自：${current.sourceBlueprintPath}${current.sourceGraphName ? ` · ${current.sourceGraphName}` : ''}`
      : '',
    '',
    '片段正文（引擎的节点序列化，也就是编辑器 Ctrl+C 那段）：',
    current.t3d.length > T3D_CONTEXT_LIMIT
      ? `${current.t3d.slice(0, T3D_CONTEXT_LIMIT)}\n…（正文太长，这里截断了）`
      : current.t3d
  ]

  return {
    library: 'blueprint',
    entryId: props.entryId,
    entryName: props.name,
    overview: overviewLines.filter(Boolean).join('\n'),
    selectedNodes: []
  }
})
</script>

<template>
  <div class="snippet-detail">
    <LibraryEditorTopbar :back-label="t('snippetDetail.back')" :name="name" @back="emit('back')">
      <template #chips>
        <span class="topbar-chip">{{ t('snippetDetail.formBadge') }}</span>
      </template>
      <template #actions>
        <AppButton type="primary" :loading="applying" @click="emit('apply')">
          {{ t('snippetDetail.applyToProject') }}
        </AppButton>
      </template>
    </LibraryEditorTopbar>

    <div class="snippet-main">
      <div v-if="summary" class="snippet-body">
        <section class="stat-row">
          <div class="stat">
            <span class="stat-value">{{ summary.nodeCount }}</span>
            <span class="stat-label">{{ t('snippetDetail.nodes') }}</span>
          </div>
          <div class="stat">
            <span class="stat-value">{{ summary.connectionCount }}</span>
            <span class="stat-label">{{ t('snippetDetail.connections') }}</span>
          </div>
          <div class="stat" :class="{ warn: summary.openPortCount > 0 }">
            <span class="stat-value">{{ summary.openPortCount }}</span>
            <span class="stat-label">{{ t('snippetDetail.openPorts') }}</span>
          </div>
        </section>

        <section v-if="summary.classes.length" class="block">
          <h3 class="block-title">{{ t('snippetDetail.nodeTypes') }}</h3>
          <div class="chip-row">
            <span v-for="cls in summary.classes" :key="cls" class="chip">{{ cls }}</span>
          </div>
        </section>

        <section v-if="summary.sourceBlueprintPath" class="block">
          <h3 class="block-title">{{ t('snippetDetail.source') }}</h3>
          <p class="block-text">
            {{ summary.sourceBlueprintPath }}
            <span v-if="summary.sourceGraphName"> · {{ summary.sourceGraphName }}</span>
          </p>
        </section>

        <section v-if="summary.openPortCount > 0" class="block note">
          <h3 class="block-title">{{ t('snippetDetail.openPortsTitle') }}</h3>
          <p class="block-text">{{ t('snippetDetail.openPortsHint') }}</p>
        </section>

        <!--
        没有画布不是「还没做完」，是这一版的范围。跟用户说清楚，
        免得他以为条目坏了。
      -->
        <section class="block note">
          <h3 class="block-title">{{ t('snippetDetail.noCanvasTitle') }}</h3>
          <p class="block-text">{{ t('snippetDetail.noCanvasHint') }}</p>
        </section>
      </div>

      <!-- 右侧：AI 面板。里面嵌的就是主助手本身 -->
      <LibraryAIPanel
        v-if="chatContext"
        :session-id="`library-chat-blueprint-${entryId}`"
        :mode="aiPanelMode"
        :context="chatContext"
        overlay-storage-prefix="blueprint-ai-panel"
        @update:mode="emit('update:aiPanelMode', $event)"
        @restore="emit('restoreAiPanel')"
      />
    </div>
  </div>
</template>

<style scoped>
.snippet-detail {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* 顶栏下面分两栏：左边摘要，右边 AI 面板（和老条目那边同一个布局） */
.snippet-main {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
}

.snippet-body {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.stat-row {
  display: flex;
  gap: var(--space-4);
}

.stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-container);
  background: var(--color-bg-surface);
}

.stat.warn {
  border-color: var(--color-border-strong);
}

.stat-value {
  font-family: var(--font-family-numeric);
  font-size: 24px;
  color: var(--color-text-primary);
}

.stat-label {
  font-size: 12px;
  color: var(--color-text-muted);
}

.block-title {
  margin: 0 0 var(--space-2);
  font-size: 13px;
  color: var(--color-text-secondary);
}

.block-text {
  margin: 0;
  font-size: 13px;
  color: var(--color-text-muted);
  line-height: 1.7;
}

.block.note {
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-container);
  background: var(--color-bg-surface);
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.chip {
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  font-size: 12px;
  color: var(--color-text-secondary);
}

.topbar-chip {
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-xs);
  background: var(--color-bg-raised);
  font-size: 12px;
  color: var(--color-text-secondary);
}
</style>
