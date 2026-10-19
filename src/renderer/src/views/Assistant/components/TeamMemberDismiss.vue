<template>
  <!--
    任务板上辞退一个队员：一个不起眼的文字按钮，点开要写理由才能确认。
    对话框里摆出盒子从账上数出的事实，和存进档案的是同一份（countDismissalFacts）。
    两种画风的任务板共用；像素画风只换按钮外观（`pixel`）。
  -->
  <span class="member-dismiss-wrap">
    <button
      type="button"
      class="member-dismiss"
      :class="{ 'is-pixel': pixel }"
      :disabled="busy"
      :title="busy ? t('assistant.teamBoard.dismiss.busyHint', { name: member.name }) : undefined"
      @click="open = true"
    >
      {{ t('assistant.teamBoard.dismiss.action') }}
    </button>
    <AppModal
      :open="open"
      :title="t('assistant.teamBoard.dismiss.title', { name: member.name })"
      :ok-text="t('assistant.teamBoard.dismiss.action')"
      :ok-disabled="!reason.trim()"
      ok-danger
      destroy-on-close
      @ok="confirm"
      @update:open="(value: boolean) => (open = value)"
    >
      <div class="dismiss-body">
        <p>{{ t('assistant.teamBoard.dismiss.lead', { name: member.name }) }}</p>
        <p v-if="openTasks > 0">
          {{ t('assistant.teamBoard.dismiss.handover', { n: openTasks }) }}
        </p>
        <p class="dismiss-facts">
          {{
            t('assistant.teamBoard.dismiss.facts', {
              done: facts.jobsDone,
              stopped: facts.jobsStopped
            })
          }}
        </p>
        <label class="dismiss-field">
          <span>{{ t('assistant.teamBoard.dismiss.reasonLabel') }}</span>
          <a-textarea
            v-model:value="reason"
            :maxlength="500"
            :auto-size="{ minRows: 3, maxRows: 6 }"
            :placeholder="t('assistant.teamBoard.dismiss.reasonPlaceholder')"
          />
        </label>
      </div>
    </AppModal>
  </span>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import AppModal from '@renderer/components/AppModal.vue'
import { countDismissalFacts, type TeamMember, type TeamStateView } from '@core/shared/agentTeam'

const props = defineProps<{
  member: TeamMember
  team: TeamStateView
  /** 手上有活：主进程会拒，这里先灰掉 */
  busy?: boolean
  pixel?: boolean
}>()
const emit = defineEmits<{
  dismiss: [name: string, reason: string]
}>()
const { t } = useI18n()

const open = ref(false)
const reason = ref('')
watch(open, (value) => value && (reason.value = ''))

const facts = computed(() =>
  countDismissalFacts(props.member.name, props.team.jobs ?? [], props.team.board)
)
const openTasks = computed(
  () => facts.value.tasks.todo + facts.value.tasks.doing + facts.value.tasks.blocked
)

function confirm(): void {
  const text = reason.value.trim()
  if (!text) return
  open.value = false
  emit('dismiss', props.member.name, text)
}
</script>

<style scoped lang="less">
.member-dismiss {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-family: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;

  &:hover:not(:disabled) {
    color: var(--color-danger-text);
  }

  &:disabled {
    cursor: not-allowed;
    color: var(--color-text-disabled);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 1px;
    border-radius: var(--radius-sm);
  }

  &.is-pixel {
    color: var(--q-paper);

    &:hover:not(:disabled) {
      color: var(--q-red);
    }
  }
}

.dismiss-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);

  p {
    margin: 0;
  }
}

.dismiss-facts {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.dismiss-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-2);
}
</style>
