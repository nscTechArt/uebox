<template>
  <!--
    成员：一人一行，回答「谁在干嘛、谁卡住了」。取代原来的成员胶囊和「动态」流水账。

    默认只有：身份色、名字、只读锁、此刻在干嘛的一句话、时间。
    点一行：选中这个人（下面的任务和留言只看他），并在行下展开他的模型、手上的活和最近几步。
    悬停一行：办公室里把这个人标出来。
  -->
  <ul v-if="rows.length" class="roster">
    <li
      v-for="row in rows"
      :key="row.id"
      class="member"
      :class="{ 'is-selected': row.selected, 'is-alert': row.alert }"
      @mouseenter="emit('hover', row.id)"
      @mouseleave="emit('hover', null)"
    >
      <button
        type="button"
        class="member-main"
        :aria-expanded="row.selected"
        :title="row.assignment || row.member.persona"
        @click="emit('select', row.selected ? null : row.id)"
      >
        <span class="swatch" :style="{ background: row.color }" />
        <span class="member-name">{{ row.member.name }}</span>
        <PhLock
          v-if="row.member.readOnly"
          class="member-lock"
          weight="bold"
          :aria-label="t('assistant.teamBoard.readOnly')"
        />
        <span class="member-status" :title="row.status">{{ row.status }}</span>
        <span v-if="row.at" class="member-when" :title="exact(row.at)">{{ ago(row.at) }}</span>
      </button>

      <div v-if="row.selected" class="member-detail">
        <div class="detail-meta">
          <!-- 它用的模型。只有一个模型可选时不显示：没得换，显示了也是噪音 -->
          <AppDropdown
            v-if="showModels"
            :trigger="['click']"
            @update:open="(open: boolean) => open && emit('open-models')"
          >
            <button
              type="button"
              class="member-model"
              :class="{ unavailable: isUnavailable(row.member) }"
              :title="modelTitle(row.member)"
            >
              <PhWarning v-if="isUnavailable(row.member)" class="member-model-icon" />
              {{ memberModelLabel(row.member) }}
              <PhCaretDown class="member-model-icon" />
            </button>
            <template #overlay>
              <AppMenu
                class="member-model-menu"
                :selected-keys="row.member.model ? [modelKey(row.member.model)] : []"
              >
                <AppMenuItemGroup
                  v-for="group in modelGroups"
                  :key="group.providerName"
                  :title="group.providerName"
                >
                  <AppMenuItem
                    v-for="choice in group.choices"
                    :key="choice.key"
                    :item-key="choice.key"
                    @click="pickModel(row.member, choice)"
                  >
                    {{ choice.name }}
                  </AppMenuItem>
                </AppMenuItemGroup>
              </AppMenu>
            </template>
          </AppDropdown>
          <span v-if="row.member.readOnly" class="detail-flag">
            {{ t('assistant.teamBoard.readOnlyHint') }}
          </span>
          <span v-if="row.member.persona" class="detail-persona">{{ row.member.persona }}</span>
        </div>
        <p v-if="row.assignment" class="detail-assignment">
          <span class="detail-label">{{ t('assistant.teamBoard.assignment') }}</span>
          {{ row.assignment }}
        </p>
        <ol v-if="row.steps.length" class="steps" :aria-label="t('assistant.teamBoard.steps')">
          <li v-for="(step, index) in row.steps" :key="index" class="step">
            <span class="step-when" :title="exact(step.at)">
              {{ step.showTime ? ago(step.at) : '' }}
            </span>
            <span v-if="step.tool" class="step-action" :title="stepTitle(step)">
              {{ toolVerb(step.tool) }}
              <template v-if="step.targets.length">
                <span class="step-target">· {{ shortTarget(step.targets.at(-1)!) }}</span>
                <span v-if="step.targets.length > 1" class="step-count">
                  {{ t('assistant.teamBoard.stepTimes', { n: step.targets.length }) }}
                </span>
              </template>
            </span>
            <button
              v-else
              type="button"
              class="step-speech"
              :class="{ clamp: !speechOpen.has(`${row.id}:${step.at}`) }"
              @click="toggleSpeech(`${row.id}:${step.at}`)"
            >
              {{ step.text }}
            </button>
          </li>
        </ol>
        <p v-else class="detail-empty">{{ t('assistant.teamBoard.noSteps') }}</p>
      </div>
    </li>
  </ul>
  <p v-else class="empty">{{ t('assistant.teamBoard.noMembers') }}</p>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCaretDown, PhLock, PhWarning } from '@phosphor-icons/vue'

import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import AppMenuItemGroup from '@renderer/components/AppMenuItemGroup.vue'
import {
  sameTeamModel,
  teamModelLabel,
  type TeamActivity,
  type TeamMember,
  type TeamModel,
  type TeamModelCandidate,
  type TeamStateView
} from '@core/shared/agentTeam'

import { useTeamLabels } from './teamBoardLabels'
import { memberStatus, recentSteps, shortTarget, statusRank, type StepGroup } from './teamBoardView'
import { crewColor, crewIndexOf, officeStyle } from './teamOffice/officeStyle'

const props = defineProps<{
  team: TeamStateView
  activity: TeamActivity[]
  selected: string | null
  modelChoices?: TeamModelCandidate[]
  modelsLoaded?: boolean
}>()
const emit = defineEmits<{
  select: [id: string | null]
  hover: [id: string | null]
  'open-models': []
  'set-model': [name: string, model: TeamModel]
}>()
const { t } = useI18n()
const { ago, exact, toolVerb, statusText } = useTeamLabels()

const memberId = (name: string): string => name.trim().toLowerCase()

const rows = computed(() =>
  [...props.team.members]
    .sort((a, b) => a.hiredAt - b.hiredAt)
    .map((member) => {
      const id = memberId(member.name)
      const status = memberStatus(props.team, member.name, props.activity)
      const selected = props.selected === id
      return {
        id,
        member,
        rank: statusRank(status),
        status: statusText(status),
        alert: status.kind === 'stopped' || status.kind === 'blocked',
        at: 'at' in status ? status.at : undefined,
        color: crewColor(crewIndexOf(props.team, member.name), officeStyle.value),
        assignment: props.team.live?.assignments.find((a) => memberId(a.member) === id)?.text ?? '',
        selected,
        steps: selected ? recentSteps(props.activity, member.name) : []
      }
    })
    // 要人处理的排前面，其余按入职顺序（sort 是稳定的）
    .sort((a, b) => a.rank - b.rank)
)

const speechOpen = reactive(new Set<string>())
function toggleSpeech(key: string): void {
  if (speechOpen.has(key)) speechOpen.delete(key)
  else speechOpen.add(key)
}

/** 悬停看原始工具名和完整目标：排查时用得着 */
function stepTitle(step: StepGroup): string {
  return [step.tool, ...step.targets].join('\n')
}

// ── 队员的模型 ──────────────────────────────────────────────────────────

const choices = computed(() => props.modelChoices ?? [])
const showModels = computed(() => choices.value.length > 1)

const modelGroups = computed(() => {
  const groups: { providerName: string; choices: TeamModelCandidate[] }[] = []
  for (const choice of choices.value) {
    const last = groups[groups.length - 1]
    if (last?.providerName === choice.providerName) last.choices.push(choice)
    else groups.push({ providerName: choice.providerName, choices: [choice] })
  }
  return groups
})

function findChoice(model: TeamModel): TeamModelCandidate | undefined {
  return choices.value.find((choice) => sameTeamModel(choice, model))
}

function modelKey(model: TeamModel): string {
  return findChoice(model)?.key ?? `${model.providerId}/${model.modelId}`
}

function modelName(model: TeamModel): string {
  return teamModelLabel(choices.value, model)
}

/**
 * 面板上显示的模型名。老名册里没钉模型的队员照旧按档位走（主进程 `routeMember`），
 * 这里照实说它跟着谁；用户点开选一个，就钉上了
 */
function memberModelLabel(member: TeamMember): string {
  if (member.model) return modelName(member.model)
  return member.tier === 'fast'
    ? t('assistant.teamBoard.model.chatModel')
    : t('assistant.teamBoard.model.followProducer')
}

/** 名单里已经没有它了：派活时这件会改用制作人的模型（主进程 `routeMember`） */
function isUnavailable(member: TeamMember): boolean {
  return !!props.modelsLoaded && !!member.model && !findChoice(member.model)
}

/** 悬停说明：用不了的说用不了；否则说是谁定的、为什么，再说怎么换 */
function modelTitle(member: TeamMember): string {
  if (!member.model) return t('assistant.teamBoard.model.change')
  if (isUnavailable(member)) {
    return t('assistant.teamBoard.model.unavailable', { model: modelName(member.model) })
  }
  const lines = [
    member.modelBy === 'user'
      ? t('assistant.teamBoard.model.byUser')
      : member.modelReason
        ? t('assistant.teamBoard.model.reason', { reason: member.modelReason })
        : '',
    t('assistant.teamBoard.model.change')
  ]
  return lines.filter(Boolean).join('\n')
}

function pickModel(member: TeamMember, choice: TeamModelCandidate): void {
  if (member.model && sameTeamModel(member.model, choice)) return
  emit('set-model', member.name, { providerId: choice.providerId, modelId: choice.modelId })
}
</script>

<style scoped lang="less">
.roster {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.member {
  border-radius: var(--radius-md);

  &.is-selected {
    background: var(--color-bg-sunken);
  }
}

.member-main {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  padding: var(--space-2);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-secondary);
  font-family: inherit;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
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
}

.swatch {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
}

.member-name {
  flex-shrink: 0;
  color: var(--color-text-primary);
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
}

.member-lock {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  color: var(--color-text-muted);
}

.member-status {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;

  .is-alert & {
    color: var(--color-danger-text);
  }
}

.member-when {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.member-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 0 var(--space-2) var(--space-3) calc(var(--space-2) + 8px + var(--space-2));
  font-size: var(--font-size-sm);
}

.detail-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.detail-persona {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.detail-assignment {
  margin: 0;
  color: var(--color-text-secondary);
  line-height: var(--line-height-relaxed);
  overflow-wrap: anywhere;
}

.detail-label {
  margin-right: var(--space-1);
  color: var(--color-text-muted);
}

.member-model {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-family: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;

  &:hover {
    color: var(--color-text-primary);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 1px;
    border-radius: var(--radius-sm);
  }

  &.unavailable {
    color: var(--color-warning-text);
  }
}

.member-model-icon {
  flex-shrink: 0;
}

.member-model-menu {
  max-height: min(360px, calc(50vh - var(--space-6)));
  overflow-y: auto;
  overscroll-behavior-y: contain;
}

.steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.step {
  display: grid;
  grid-template-columns: 4.5em 1fr;
  column-gap: var(--space-2);
  align-items: baseline;
  min-width: 0;
}

.step-when {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.step-action {
  min-width: 0;
  color: var(--color-text-secondary);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.step-target,
.step-count {
  color: var(--color-text-muted);
}

.step-count {
  margin-left: var(--space-1);
  font-size: var(--font-size-xs);
}

.step-speech {
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-primary);
  font-family: inherit;
  font-size: inherit;
  line-height: var(--line-height-relaxed);
  text-align: left;
  white-space: pre-line;
  overflow-wrap: anywhere;
  cursor: pointer;

  &.clamp {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 1px;
    border-radius: var(--radius-sm);
  }
}

.detail-empty,
.empty {
  margin: 0;
  color: var(--color-text-muted);
}

@media (prefers-reduced-motion: reduce) {
  .member-main {
    transition: none;
  }
}
</style>
