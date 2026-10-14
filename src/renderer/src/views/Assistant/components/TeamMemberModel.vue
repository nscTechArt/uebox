<template>
  <!--
    一个队员用的模型：显示名字，点开换。只有一个模型可选时整个不出现 —— 没得换，显示了也是噪音。
    两种画风的任务板共用；像素画风只换外观（`pixel`）。
  -->
  <AppDropdown
    v-if="showModels"
    :trigger="['click']"
    @update:open="(open: boolean) => open && emit('open-models')"
  >
    <button
      type="button"
      class="member-model"
      :class="{ unavailable, 'is-pixel': pixel }"
      :title="title"
    >
      <PhWarning v-if="unavailable" class="member-model-icon" />
      {{ label }}
      <PhCaretDown class="member-model-icon" />
    </button>
    <template #overlay>
      <AppMenu
        class="member-model-menu"
        :selected-keys="member.model ? [modelKey(member.model)] : []"
      >
        <AppMenuItemGroup
          v-for="group in groups"
          :key="group.providerName"
          :title="group.providerName"
        >
          <AppMenuItem
            v-for="choice in group.choices"
            :key="choice.key"
            :item-key="choice.key"
            @click="pick(choice)"
          >
            {{ choice.name }}
          </AppMenuItem>
        </AppMenuItemGroup>
      </AppMenu>
    </template>
  </AppDropdown>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCaretDown, PhWarning } from '@phosphor-icons/vue'

import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import AppMenuItemGroup from '@renderer/components/AppMenuItemGroup.vue'
import {
  sameTeamModel,
  teamModelLabel,
  type TeamMember,
  type TeamModel,
  type TeamModelCandidate
} from '@core/shared/agentTeam'

const props = defineProps<{
  member: TeamMember
  modelChoices?: TeamModelCandidate[]
  /** 读过模型设置没有。没读过时不能断言「这个模型用不了」 */
  modelsLoaded?: boolean
  pixel?: boolean
}>()
const emit = defineEmits<{
  'open-models': []
  'set-model': [name: string, model: TeamModel]
}>()
const { t } = useI18n()

const choices = computed(() => props.modelChoices ?? [])
const showModels = computed(() => choices.value.length > 1)

const groups = computed(() => {
  const list: { providerName: string; choices: TeamModelCandidate[] }[] = []
  for (const choice of choices.value) {
    const last = list[list.length - 1]
    if (last?.providerName === choice.providerName) last.choices.push(choice)
    else list.push({ providerName: choice.providerName, choices: [choice] })
  }
  return list
})

function findChoice(model: TeamModel): TeamModelCandidate | undefined {
  return choices.value.find((choice) => sameTeamModel(choice, model))
}

function modelKey(model: TeamModel): string {
  return findChoice(model)?.key ?? `${model.providerId}/${model.modelId}`
}

/**
 * 老名册里没钉模型的队员照旧按档位走（主进程 `routeMember`），这里照实说它跟着谁；
 * 用户点开选一个，就钉上了
 */
const label = computed(() => {
  const member = props.member
  if (member.model) return teamModelLabel(choices.value, member.model)
  return member.tier === 'fast'
    ? t('assistant.teamBoard.model.chatModel')
    : t('assistant.teamBoard.model.followProducer')
})

/** 名单里已经没有它了：派活时这件会改用制作人的模型（主进程 `routeMember`） */
const unavailable = computed(
  () => !!props.modelsLoaded && !!props.member.model && !findChoice(props.member.model)
)

/** 悬停说明：用不了的说用不了；否则说是谁定的、为什么，再说怎么换 */
const title = computed(() => {
  const member = props.member
  if (!member.model) return t('assistant.teamBoard.model.change')
  if (unavailable.value) {
    return t('assistant.teamBoard.model.unavailable', { model: label.value })
  }
  return [
    member.modelBy === 'user'
      ? t('assistant.teamBoard.model.byUser')
      : member.modelReason
        ? t('assistant.teamBoard.model.reason', { reason: member.modelReason })
        : '',
    t('assistant.teamBoard.model.change')
  ]
    .filter(Boolean)
    .join('\n')
})

function pick(choice: TeamModelCandidate): void {
  if (props.member.model && sameTeamModel(props.member.model, choice)) return
  emit('set-model', props.member.name, { providerId: choice.providerId, modelId: choice.modelId })
}
</script>

<style scoped lang="less">
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

  /* 像素画风：一块小木牌 */
  &.is-pixel {
    padding: 1px 6px;
    background: var(--q-ink-soft);
    color: var(--q-paper);
    box-shadow:
      0 -2px 0 0 var(--q-edge),
      0 2px 0 0 var(--q-edge),
      -2px 0 0 0 var(--q-edge),
      2px 0 0 0 var(--q-edge);

    &:hover {
      color: var(--q-gold);
    }

    &:focus-visible {
      outline: 2px solid var(--q-gold);
      outline-offset: 3px;
      border-radius: 0;
    }

    &.unavailable {
      color: var(--q-red);
    }
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
</style>
