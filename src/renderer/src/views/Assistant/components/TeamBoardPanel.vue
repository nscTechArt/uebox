<template>
  <!--
    工作室模式（/team）的任务板：名册、任务、留言、验收结论。

    两处出现：输入框正上方只有一行摘要 —— 跑起来之后用户最常问的是「做到哪了」，
    几个人、几件完成、验收过没过就答了；点它在右侧面板打开「团队任务」页签（docked），
    整块高度给办公室、成员、任务和留言。不另开页面 —— 它是这条对话的一部分
    （见 docs/AI游戏工作室设计-2026-09-25.md 第 3 节）。

    面板从上到下回答：做完了吗（页头）→ 谁在干嘛、谁卡住了（成员）→ 还剩什么（任务）
    → 交回了什么（留言）。机器写的细节（工具名、路径、模型、回执、报告全文）都在悬停或点开之后。
  -->
  <section
    class="team-board"
    :class="{ 'is-docked': docked }"
    :aria-label="t('assistant.teamBoard.title')"
  >
    <component
      :is="docked ? 'div' : 'button'"
      :type="docked ? undefined : 'button'"
      class="team-board-head"
      :title="docked ? undefined : t('assistant.teamBoard.openTab')"
      @click="docked || emit('open')"
    >
      <PhUsersThree class="head-icon" />
      <span class="head-title">{{ t('assistant.teamBoard.title') }}</span>
      <span class="head-meta">
        {{
          t('assistant.teamBoard.summary', {
            members: team.members.length,
            done: doneCount,
            total: team.board.length
          })
        }}
      </span>
      <AppTag v-if="team.verdict" :tone="verdictTone" :title="verdictTitle">
        {{ verdictLabel }}
      </AppTag>
      <PhCaretRight v-if="!docked" class="caret" />
      <AppButton
        v-else
        class="team-board-end"
        size="small"
        variant="text"
        :disabled="running"
        :title="
          running ? t('assistant.teamBoard.endWhileRunning') : t('assistant.teamBoard.endHint')
        "
        @click="emit('end')"
      >
        {{ t('assistant.teamBoard.end') }}
      </AppButton>
    </component>

    <div v-if="docked" class="team-board-stage">
      <div ref="bodyRef" class="team-board-body" :inert="readerIndex !== null || undefined">
        <TeamOffice
          :team="team"
          :running="running"
          :session-id="sessionId"
          :activity="activity ?? []"
          :model-choices="modelChoices"
          :selected="selected"
          :highlight="hovered"
          @select="select"
        />

        <section class="block">
          <h4 class="block-label">{{ t('assistant.teamBoard.objective') }}</h4>
          <p class="objective" :title="team.objective">{{ team.objective }}</p>
        </section>

        <section class="block">
          <h4 class="block-title">
            {{ t('assistant.teamBoard.members') }}
            <span class="block-count">{{ team.members.length }}</span>
            <AppTag
              v-if="selectedName"
              class="filter-chip"
              tone="info"
              removable
              :remove-label="t('assistant.teamBoard.clearFilter')"
              @remove="select(null)"
            >
              {{ t('assistant.teamBoard.office.only', { name: selectedName }) }}
            </AppTag>
          </h4>
          <TeamRoster
            :team="team"
            :activity="activity ?? []"
            :selected="selected"
            :model-choices="modelChoices"
            :models-loaded="modelsLoaded"
            @select="select"
            @hover="hovered = $event"
            @open-models="emit('open-models')"
            @set-model="(name, model) => emit('set-model', name, model)"
          />
        </section>

        <section class="block">
          <h4 class="block-title">
            {{ t('assistant.teamBoard.tasks') }}
            <span class="block-count">{{ doneCount }}/{{ team.board.length }}</span>
          </h4>
          <TeamTaskList :team="team" :selected="selected" @reopen="emit('reopen', $event)" />
        </section>

        <section v-if="mails.length" class="block">
          <h4 class="block-title">
            {{ t('assistant.teamBoard.mail') }}
            <span class="block-count">{{ mails.length }}</span>
          </h4>
          <TeamMailList :team="team" :items="mails" @read="openReader" />
        </section>
      </div>

      <TeamMailReader
        v-if="readerIndex !== null && mails[readerIndex]"
        :team="team"
        :items="mails"
        :index="readerIndex"
        @go="readerIndex = $event"
        @close="closeReader"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCaretRight, PhUsersThree } from '@phosphor-icons/vue'

import AppButton from '@renderer/components/AppButton.vue'
import AppTag from '@renderer/components/AppTag.vue'
import type {
  TeamActivity,
  TeamModel,
  TeamModelCandidate,
  TeamStateView,
  TeamVerdict
} from '@core/shared/agentTeam'
import TeamMailList from './TeamMailList.vue'
import TeamMailReader from './TeamMailReader.vue'
import TeamOffice from './teamOffice/TeamOffice.vue'
import TeamRoster from './TeamRoster.vue'
import TeamTaskList from './TeamTaskList.vue'
import { useTeamLabels } from './teamBoardLabels'
import { mailItems } from './teamMail'

const props = defineProps<{
  team: TeamStateView
  /** 这条对话正在跑：这时候不能结束团队模式（这一轮收尾会把团队状态写回去） */
  running?: boolean
  /** 队员能换成哪些模型。和制作人招人时的候选同一份 */
  modelChoices?: TeamModelCandidate[]
  /** 模型设置读到过没有。没读到时不能说某个模型「用不了」 */
  modelsLoaded?: boolean
  /** 在右侧面板里整块显示；不带时只有输入框上方那一行摘要 */
  docked?: boolean
  /** 内核 session：办公室按它认制作人的实时进度 */
  sessionId?: string
  /** 队员最近的动态，旧的在前 */
  activity?: TeamActivity[]
}>()
const emit = defineEmits<{
  /** 用户点了摘要行：在右侧面板打开「团队任务」 */
  open: []
  /** 用户把一项卡住的改回待办 */
  reopen: [taskId: string]
  /** 用户结束团队模式 */
  end: []
  /** 用户打开了团队任务或换模型菜单：重读一次模型设置 */
  'open-models': []
  /** 用户给队员换了模型 */
  'set-model': [name: string, model: TeamModel]
}>()
const { t } = useI18n()
const { ago } = useTeamLabels()

/** 打开时顺手重读模型名单：用户可能刚在设置页增删过来源，模型名和「用不了」要跟上 */
onMounted(() => {
  if (props.docked) emit('open-models')
})

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

const VERDICT_TONE: Record<TeamVerdict, Tone> = {
  pass: 'success',
  fail: 'warning',
  blocked: 'danger'
}

const doneCount = computed(() => props.team.board.filter((task) => task.status === 'done').length)

// ── 只看某个队员（在办公室里点人，或点名册里的那一行） ───────────────────

const memberId = (name: string): string => name.trim().toLowerCase()
const selected = ref<string | null>(null)
/** 鼠标停在名册哪一行：办公室里把那个人标出来 */
const hovered = ref<string | null>(null)
function select(id: string | null): void {
  selected.value = id
}
const selectedName = computed(
  () => props.team.members.find((m) => memberId(m.name) === selected.value)?.name ?? null
)
// 名册里没这个人了（结束重开、换了一批人），筛选跟着撤掉
watch(selectedName, (name) => {
  if (!name) selected.value = null
})

// ── 留言和阅读视图 ──────────────────────────────────────────────────────

const mails = computed(() => mailItems(props.team, selected.value))

const bodyRef = ref<HTMLElement | null>(null)
const readerIndex = ref<number | null>(null)
let readerReturn: { scroll: number; mailId: string } | null = null

function openReader(mailId: string): void {
  const index = mails.value.findIndex((item) => item.mail.id === mailId)
  if (index < 0) return
  readerReturn = { scroll: bodyRef.value?.scrollTop ?? 0, mailId }
  readerIndex.value = index
}

/** 回到原来读到的地方，焦点回到打开它的那张卡上 */
async function closeReader(): Promise<void> {
  readerIndex.value = null
  await nextTick()
  const back = readerReturn
  readerReturn = null
  if (!back || !bodyRef.value) return
  bodyRef.value.scrollTop = back.scroll
  bodyRef.value
    .querySelector<HTMLElement>(`[data-mail-id="${CSS.escape(back.mailId)}"] button`)
    ?.focus()
}

// ── 验收 ────────────────────────────────────────────────────────────────

/**
 * 验收之后工程又改过：那次结论只说明当时的游戏。红牌「未过」一直挂着，
 * 用户会以为现在还是那样（2026-09-30 真机），所以换成中性的「改动后未重验」。
 */
const verdictLabel = computed(() =>
  props.team.verdictStale
    ? t('assistant.teamBoard.verdict.stale')
    : t(`assistant.teamBoard.verdict.${props.team.verdict}`)
)
const verdictTone = computed<Tone>(() =>
  props.team.verdictStale || !props.team.verdict ? 'neutral' : VERDICT_TONE[props.team.verdict]
)
const verdictTitle = computed(() =>
  props.team.verdictAt === undefined
    ? undefined
    : t('assistant.teamBoard.verdictTitle', {
        count: props.team.deliveries,
        when: ago(props.team.verdictAt)
      })
)
</script>

<style scoped lang="less">
.team-board {
  margin-bottom: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  overflow: hidden;
}

.team-board.is-docked {
  display: flex;
  flex-direction: column;
  height: 100%;
  margin: 0;
  border: none;
  border-radius: 0;
}

.team-board-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-family: inherit;
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
  transition: background-color 140ms ease;

  &:hover {
    background: var(--color-bg-surface-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: -2px;
  }

  .is-docked > & {
    flex-shrink: 0;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--color-border-subtle);
    cursor: default;

    &:hover {
      background: transparent;
    }
  }
}

.head-icon {
  flex-shrink: 0;
  color: var(--color-text-primary);
}

.head-title {
  color: var(--color-text-primary);
  font-weight: var(--font-weight-semibold);
}

.head-meta {
  flex: 1;
  min-width: 0;
  color: var(--color-text-muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.caret,
.team-board-end {
  flex-shrink: 0;
  color: var(--color-text-muted);
}

/* 阅读视图盖在这一层上面 */
.team-board-stage {
  position: relative;
  flex: 1;
  min-height: 0;
}

.team-board-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  height: 100%;
  padding: var(--space-4);
  overflow-y: auto;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
}

.block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.block-title,
.block-label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 22px;
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.04em;
}

.block-label {
  min-height: 0;
  color: var(--color-text-muted);
  font-weight: var(--font-weight-normal);
}

.block-count {
  color: var(--color-text-muted);
  font-family: var(--font-family-numeric);
  font-weight: var(--font-weight-normal);
}

.filter-chip {
  margin-left: auto;
  letter-spacing: normal;
}

/* 目标：一行，悬停看全文 */
.objective {
  margin: -2px 0 0;
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

@media (prefers-reduced-motion: reduce) {
  .team-board-head {
    transition: none;
  }
}
</style>
