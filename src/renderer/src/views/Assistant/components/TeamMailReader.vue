<template>
  <!--
    阅读视图：在面板里铺满，读一份长报告。顶部一条：返回、谁发给谁、时间、上一条 / 下一条。
    Esc 或「返回」回到原来的位置（面板负责还原滚动和焦点）。
  -->
  <div
    class="reader"
    role="dialog"
    :aria-label="t('assistant.teamBoard.openReader')"
    @keydown.esc.stop="emit('close')"
  >
    <header class="reader-bar">
      <button ref="backRef" type="button" class="reader-back" @click="emit('close')">
        <PhArrowLeft />
        {{ t('assistant.teamBoard.backToBoard') }}
      </button>
      <span class="swatch" :style="{ background: color }" />
      <span class="reader-from">{{ who(item.mail.from) }}</span>
      <template v-if="item.role !== 'delivery' && item.role !== 'stopped'">
        <span class="reader-muted">→ {{ who(item.mail.to) }}</span>
      </template>
      <span class="reader-muted">{{ t(`assistant.teamBoard.mailRole.${item.role}`) }}</span>
      <span class="reader-meta" :title="exact(item.mail.at)">
        <template v-if="item.model">{{ item.model }} · </template>{{ ago(item.mail.at) }}
      </span>
      <button
        type="button"
        class="reader-nav"
        :disabled="index <= 0"
        :aria-label="t('assistant.teamBoard.prevMail')"
        :title="t('assistant.teamBoard.prevMail')"
        @click="emit('go', index - 1)"
      >
        <PhCaretLeft />
      </button>
      <button
        type="button"
        class="reader-nav"
        :disabled="index >= items.length - 1"
        :aria-label="t('assistant.teamBoard.nextMail')"
        :title="t('assistant.teamBoard.nextMail')"
        @click="emit('go', index + 1)"
      >
        <PhCaretRight />
      </button>
    </header>
    <div ref="scrollRef" class="reader-scroll">
      <article class="reader-body">
        <MarkdownRenderer :content="item.body" />
        <dl v-if="item.extras.length" class="reader-extras">
          <div v-for="(extra, i) in item.extras" :key="i" class="reader-extra">
            <dt>{{ extraLabel(extra.label) }}</dt>
            <dd>{{ extra.text }}</dd>
          </div>
        </dl>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhArrowLeft, PhCaretLeft, PhCaretRight } from '@phosphor-icons/vue'

import { PRODUCER, type TeamStateView } from '@core/shared/agentTeam'

import MarkdownRenderer from './MarkdownRenderer.vue'
import type { MailExtra } from './teamBoardText'
import { useTeamLabels } from './teamBoardLabels'
import type { MailItem } from './teamMail'
import { crewColor, crewIndexOf, officeStyle } from './teamOffice/officeStyle'

const props = defineProps<{
  team: TeamStateView
  items: MailItem[]
  index: number
}>()
const emit = defineEmits<{ close: []; go: [index: number] }>()
const { t } = useI18n()
const { ago, exact, who } = useTeamLabels()

const backRef = ref<HTMLButtonElement | null>(null)
const scrollRef = ref<HTMLElement | null>(null)

const item = computed(() => props.items[props.index]!)
const color = computed(() =>
  item.value.mail.from === PRODUCER
    ? crewColor(-1, officeStyle.value)
    : crewColor(crewIndexOf(props.team, item.value.mail.from), officeStyle.value)
)

function extraLabel(label: MailExtra['label']): string {
  return label === 'writes' || label === 'snapshot'
    ? t(`assistant.teamBoard.extra.${label}`)
    : label
}

onMounted(() => backRef.value?.focus())
// 翻到另一条：从头读
watch(
  () => props.index,
  async () => {
    await nextTick()
    scrollRef.value?.scrollTo({ top: 0 })
  }
)
</script>

<style scoped lang="less">
.reader {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  background: var(--color-bg-surface);
  animation: reader-in 160ms ease;
}

@keyframes reader-in {
  from {
    opacity: 0;
    transform: translateY(var(--space-2));
  }
}

.reader-bar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--font-size-sm);
}

.reader-back,
.reader-nav {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;

  &:hover:not(:disabled) {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }

  &:disabled {
    color: var(--color-text-disabled);
    cursor: default;
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: -2px;
  }
}

.reader-back {
  margin-right: var(--space-2);
}

.swatch {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
}

.reader-from {
  flex-shrink: 0;
  color: var(--color-text-primary);
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
}

.reader-muted {
  flex-shrink: 0;
  color: var(--color-text-muted);
  white-space: nowrap;
}

.reader-meta {
  flex: 1;
  min-width: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  text-align: right;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.reader-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.reader-body {
  max-width: 72ch;
  margin: 0 auto;
  padding: var(--space-6);
}

.reader-extras {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--space-1) var(--space-3);
  margin: var(--space-6) 0 0;
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-separator);
  font-size: var(--font-size-xs);

  dt {
    color: var(--color-text-muted);
  }

  dd {
    margin: 0;
    color: var(--color-text-secondary);
    overflow-wrap: anywhere;
  }
}

.reader-extra {
  display: contents;
}

@media (prefers-reduced-motion: reduce) {
  .reader {
    animation: none;
  }
}
</style>
