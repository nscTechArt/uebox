<template>
  <!--
    留言：往来记录，新的在上。

    默认一条一张卡：谁发的（交付 / 中断给标签，其余写「→ 收件人 · 类型」）、时间、
    报告标题一行、摘要两行。制作人发出去对方还没读到的，时间前一个小圆点。
    悬停：模型、回执。点卡片：就地展开全文（按 Markdown 排版）；很长的报告给「在阅读视图中打开」。
  -->
  <ul class="mails">
    <li
      v-for="item in items"
      :key="item.mail.id"
      class="mail"
      :class="{
        'is-stopped': item.role === 'stopped',
        'is-producer': item.fromProducer,
        'is-open': isOpen(item.mail.id)
      }"
      :data-mail-id="item.mail.id"
    >
      <div class="mail-head">
        <span class="swatch" :style="{ background: colorOf(item.mail.from) }" />
        <span class="mail-from">{{ who(item.mail.from) }}</span>
        <AppTag v-if="item.role === 'delivery'" tone="success">
          {{ t('assistant.teamBoard.mailRole.delivery') }}
        </AppTag>
        <AppTag v-else-if="item.role === 'stopped'" tone="danger">
          {{ t('assistant.teamBoard.mailRole.stopped') }}
        </AppTag>
        <template v-else>
          <span class="mail-arrow">→</span>
          <span class="mail-to">{{ who(item.mail.to) }}</span>
          <span class="mail-role">{{ t(`assistant.teamBoard.mailRole.${item.role}`) }}</span>
        </template>
        <span class="mail-meta">
          <template v-if="item.model">{{ item.model }}</template>
          <template v-if="item.fromProducer">
            <template v-if="item.model"> · </template>{{ receipt(item) }}
          </template>
        </span>
        <span
          v-if="item.unread"
          class="unread-dot"
          role="img"
          :aria-label="t('assistant.teamBoard.unread')"
          :title="t('assistant.teamBoard.unread')"
        />
        <span class="mail-when" :title="exact(item.mail.at)">{{ ago(item.mail.at) }}</span>
      </div>

      <button
        v-if="!isOpen(item.mail.id)"
        type="button"
        class="mail-preview"
        :aria-expanded="false"
        @click="toggle(item.mail.id)"
      >
        <span v-if="item.title" class="mail-title">{{ item.title }}</span>
        <span v-if="item.summary" class="mail-summary">{{ item.summary }}</span>
      </button>

      <div v-else class="mail-full">
        <div class="mail-md" :class="{ 'is-capped': item.long }">
          <MarkdownRenderer class="team-md" :content="item.body" />
        </div>
        <dl v-if="item.extras.length" class="mail-extras">
          <div v-for="(extra, index) in item.extras" :key="index" class="mail-extra">
            <dt>{{ extraLabel(extra.label) }}</dt>
            <dd>{{ extra.text }}</dd>
          </div>
        </dl>
        <div class="mail-actions">
          <button
            type="button"
            class="mail-action"
            :aria-expanded="true"
            @click="toggle(item.mail.id)"
          >
            {{ t('assistant.teamBoard.less') }}
          </button>
          <button
            v-if="item.long"
            type="button"
            class="mail-action is-primary"
            @click="emit('read', item.mail.id)"
          >
            {{ t('assistant.teamBoard.openReader') }}
            <template v-if="item.sections > 1">
              · {{ t('assistant.teamBoard.sections', { n: item.sections }) }}
            </template>
          </button>
        </div>
      </div>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { reactive } from 'vue'
import { useI18n } from 'vue-i18n'

import AppTag from '@renderer/components/AppTag.vue'
import { PRODUCER, type TeamStateView } from '@core/shared/agentTeam'

import MarkdownRenderer from './MarkdownRenderer.vue'
import type { MailExtra } from './teamBoardText'
import { useTeamLabels } from './teamBoardLabels'
import type { MailItem } from './teamMail'
import { crewColor, crewIndexOf, officeStyle } from './teamOffice/officeStyle'

const props = defineProps<{
  team: TeamStateView
  items: MailItem[]
}>()
const emit = defineEmits<{ read: [mailId: string] }>()
const { t } = useI18n()
const { ago, exact, who } = useTeamLabels()

/** 展开了哪几张（按 id），刷新数据不会合上 */
const opened = reactive(new Set<string>())
const isOpen = (id: string): boolean => opened.has(id)
function toggle(id: string): void {
  if (opened.has(id)) opened.delete(id)
  else opened.add(id)
}

function colorOf(name: string): string {
  return name === PRODUCER
    ? crewColor(-1, officeStyle.value)
    : crewColor(crewIndexOf(props.team, name), officeStyle.value)
}

function receipt(item: MailItem): string {
  if (item.mail.readAt) return t('assistant.teamBoard.receipt.read')
  if (item.mail.deliveredAt) return t('assistant.teamBoard.receipt.delivered')
  return t('assistant.teamBoard.receipt.queued')
}

function extraLabel(label: MailExtra['label']): string {
  return label === 'writes' || label === 'snapshot'
    ? t(`assistant.teamBoard.extra.${label}`)
    : label
}
</script>

<style scoped lang="less">
.mails {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.mail {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--color-bg-sunken);
  transition: background-color 140ms ease;

  &:hover {
    background: var(--color-bg-soft);
  }

  /* 中断：左边一道危险色，不再整圈描红 */
  &.is-stopped {
    box-shadow: inset 2px 0 0 var(--color-danger-border);
  }
}

.mail-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
}

.swatch {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
}

.mail-from {
  flex-shrink: 0;
  color: var(--color-text-primary);
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
}

.mail-arrow,
.mail-role {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.mail-to {
  flex-shrink: 0;
  color: var(--color-text-secondary);
  white-space: nowrap;
}

/* 模型、回执：机器的事，悬停或展开时才露出来 */
.mail-meta {
  flex: 1;
  min-width: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  text-align: right;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  visibility: hidden;

  .mail:hover &,
  .mail:focus-within &,
  .is-open & {
    visibility: visible;
  }
}

.unread-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-accent-solid);
}

.mail-when {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.mail-preview {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0;
  border: none;
  background: transparent;
  font-family: inherit;
  text-align: left;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }
}

.mail-title {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  line-height: var(--line-height-normal);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.mail-summary {
  display: -webkit-box;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-relaxed);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;

  .is-stopped & {
    color: var(--color-danger-text);
  }
}

/* 制作人发的指令：用户关心得少，退一档 */
.is-producer .mail-summary {
  color: var(--color-text-muted);
}

.mail-full {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* 很长的报告：卡片里只露一截，底部渐隐，全文去阅读视图 */
.mail-md.is-capped {
  max-height: calc(var(--space-6) * 14);
  overflow: hidden;
  mask-image: linear-gradient(to bottom, black 80%, transparent);
}

/* 对话里的 Markdown 是按整页排的，放进卡片要收紧：标题不再是大标题，段距缩小 */
.mail-md :deep(.team-md) {
  font-size: var(--font-size-sm);
  line-height: var(--line-height-relaxed);

  h1,
  h2,
  h3,
  h4,
  h5,
  h6 {
    margin: var(--space-3) 0 var(--space-1);
    padding: 0;
    border: none;
    font-size: 1em;
    font-weight: var(--font-weight-semibold);
  }

  > :first-child {
    margin-top: 0;
  }

  p,
  ul,
  ol,
  blockquote,
  pre,
  table {
    margin: 0 0 var(--space-2);
  }

  ul,
  ol {
    padding-left: var(--space-5);
  }

  pre {
    max-height: calc(var(--space-6) * 8);
    overflow: auto;
  }

  hr {
    margin: var(--space-2) 0;
  }
}

.mail-extras {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px var(--space-3);
  margin: 0;
  padding-top: var(--space-2);
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

.mail-extra {
  display: contents;
}

.mail-actions {
  display: flex;
  gap: var(--space-3);
}

.mail-action {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-family: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;

  &:hover {
    color: var(--color-text-primary);
  }

  &.is-primary {
    color: var(--color-accent-text);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 1px;
    border-radius: var(--radius-sm);
  }
}

@media (prefers-reduced-motion: reduce) {
  .mail {
    transition: none;
  }
}
</style>
