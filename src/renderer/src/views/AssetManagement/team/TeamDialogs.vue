<template>
  <AppModal
    :open="dialog !== null"
    :title="title"
    :width="420"
    :ok-text="okText"
    :cancel-text="t('teamProject.cancel')"
    :ok-disabled="!canSubmit"
    :confirm-loading="busy"
    :ok-danger="dialog?.kind === 'takeBack'"
    destroy-on-close
    @ok="submit"
    @update:open="(value: boolean) => !value && closeTeamDialog(false)"
  >
    <div v-if="dialog" class="team-dialog">
      <p v-if="body" class="team-dialog-body">{{ body }}</p>
      <label v-if="fieldLabel" class="field">
        <span>{{ fieldLabel }}</span>
        <a-input
          v-model:value="text"
          :placeholder="fieldPlaceholder"
          :maxlength="200"
          data-testid="team-dialog-field"
          @press-enter="submit"
        />
      </label>
      <div v-if="error" class="team-dialog-error" role="alert">{{ error }}</div>
    </div>
    <!-- 取消签出（改过的）：两选一按结果命名 [留着改动] [不要改动]；关掉小框＝不取消（方案 3.7） -->
    <template v-if="dialog?.kind === 'cancelCheckout'" #footer>
      <AppButton :loading="busy" @click="cancelCheckout(false)">{{
        t('teamProject.dialogs.keepChanges')
      }}</AppButton>
      <AppButton danger :loading="busy" @click="cancelCheckout(true)">
        {{ t('teamProject.dialogs.discardChanges') }}
      </AppButton>
    </template>
  </AppModal>
</template>

<script setup lang="ts">
/** 团队工程的六个小框，见 teamDialogs.ts；文案逐字照方案 4.9、4.11、4.13、5.11 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from '@renderer/components/AppModal.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { teamAPI, type TeamActionResult } from '@renderer/api/team'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import { message } from '@renderer/utils/messageManager'
import { closeTeamDialog, teamDialogState } from './teamDialogs'

const { t } = useI18n()
const teamStore = useTeamStore()

const text = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const dialog = computed(() => teamDialogState.current)
const projectName = computed(() => teamStore.project?.name ?? teamStore.link?.projectName ?? '')

watch(dialog, (next) => {
  error.value = null
  busy.value = false
  text.value = next?.kind === 'milestone' ? (next.name ?? '') : ''
})

const title = computed(() => {
  const d = dialog.value
  if (!d) return ''
  switch (d.kind) {
    case 'takeBack':
      return d.count > 1
        ? t('teamProject.dialogs.takeBackAllTitle', { who: d.holder.name, n: d.count })
        : t('teamProject.dialogs.takeBackTitle', { who: d.holder.name })
    case 'reject':
      return t('teamProject.dialogs.rejectTitle', { n: d.number })
    case 'rejectAssets':
      return t('teamProject.dialogs.rejectAssetsTitle', { n: d.paths.length })
    case 'milestone':
      return d.name
        ? t('teamProject.dialogs.renameTitle')
        : t('teamProject.dialogs.milestoneTitle', { n: d.number })
    case 'freeze':
      return t('teamProject.dialogs.freezeTitle', { name: projectName.value })
    case 'unfreeze':
      return t('teamProject.dialogs.unfreezeTitle', { name: projectName.value })
    case 'sendReference':
      return t('teamProject.dialogs.sendTitle', { company: d.company.name })
    case 'cancelCheckout':
      return t('teamProject.dialogs.cancelCheckoutTitle', { name: d.name })
    default:
      return ''
  }
})

const body = computed(() => {
  const d = dialog.value
  if (!d) return ''
  if (d.kind === 'takeBack') return t('teamProject.dialogs.takeBackBody')
  if (d.kind === 'freeze') return t('teamProject.dialogs.freezeBody')
  if (d.kind === 'unfreeze') return t('teamProject.dialogs.unfreezeBody', { n: d.waiting })
  if (d.kind === 'cancelCheckout') return t('teamProject.dialogs.cancelCheckoutBody')
  return ''
})

const fieldLabel = computed(() => {
  const d = dialog.value
  if (!d) return ''
  if (d.kind === 'takeBack') return t('teamProject.dialogs.takeBackReason')
  if (d.kind === 'reject' || d.kind === 'rejectAssets') return t('teamProject.dialogs.reason')
  if (d.kind === 'milestone') return t('teamProject.dialogs.milestoneName')
  if (d.kind === 'freeze') return t('teamProject.dialogs.freezeNote')
  if (d.kind === 'sendReference') return t('teamProject.dialogs.sendNote')
  return ''
})

const fieldPlaceholder = computed(() => {
  const d = dialog.value
  if (d?.kind === 'milestone') return t('teamProject.dialogs.milestonePlaceholder')
  if (d?.kind === 'freeze') return t('teamProject.dialogs.freezePlaceholder')
  return ''
})

const okText = computed(() => {
  const d = dialog.value
  if (!d) return ''
  switch (d.kind) {
    case 'takeBack':
      return t('teamProject.dialogs.takeBack')
    case 'reject':
    case 'rejectAssets':
      return t('teamProject.dialogs.reject')
    case 'milestone':
      return d.name ? t('teamProject.dialogs.rename') : t('teamProject.dialogs.setMilestone')
    case 'freeze':
      return t('teamProject.dialogs.freeze')
    case 'unfreeze':
      return t('teamProject.dialogs.unfreeze')
    case 'sendReference':
      return t('teamProject.dialogs.send')
    default:
      return ''
  }
})

/** 原因（打回）、名字（里程碑）、说明（冻结）必填；收回的原因、发参考的说明可以不填 */
const canSubmit = computed(() => {
  const d = dialog.value
  if (!d || busy.value) return false
  if (['reject', 'rejectAssets', 'milestone', 'freeze'].includes(d.kind))
    return text.value.trim().length > 0
  return true
})

/** [留着改动]：只放掉签出；[不要改动]：先在你电脑上留一份，再丢掉 */
async function cancelCheckout(discard: boolean): Promise<void> {
  const d = dialog.value
  const key = teamStore.key
  if (!d || d.kind !== 'cancelCheckout' || !key) return
  busy.value = true
  const result = await teamAPI.cancelCheckout(key, d.path, discard)
  busy.value = false
  if (!result.success) {
    error.value = failureText(result)
    return
  }
  // 有人在等这个文件（问过你改完没）：告诉服务端你已取消签出，服务端替他签出
  const ask = teamStore.receivedAsks[d.path]
  if (ask) {
    await teamAPI.answerAsk(key, ask.id, { kind: 'released' })
    const next = { ...teamStore.receivedAsks }
    delete next[d.path]
    teamStore.receivedAsks = next
  }
  closeTeamDialog(true)
  void teamStore.loadCheckouts()
}

function failureText(result: TeamActionResult<unknown>): string {
  if (result.errorCode === 'name-taken') return t('teamProject.dialogs.nameTaken')
  if (result.errorCode === 'not-allowed') return t('teamProject.dialogs.notAllowed')
  if (result.errorCode === 'unreachable') return t('teamProject.reasons.offline')
  return t('teamProject.dialogs.failed')
}

async function submit(): Promise<void> {
  const d = dialog.value
  const key = teamStore.key
  if (!d || !key || !canSubmit.value) return
  busy.value = true
  error.value = null
  const value = text.value.trim()
  let result: TeamActionResult<unknown>
  let done = ''
  switch (d.kind) {
    case 'takeBack':
      result = await teamAPI.takeBack(key, {
        holder: d.holder.id,
        paths: d.paths,
        reason: value || undefined,
        askId: d.askId
      })
      done = t('teamProject.dialogs.takenBack', { who: d.holder.name })
      break
    case 'reject':
      result = await teamAPI.reject(key, d.number, value)
      break
    case 'rejectAssets':
      result = await teamAPI.rejectDelivery(key, d.deliveryId, d.paths, value)
      break
    case 'milestone':
      result = await teamAPI.setMilestone(key, d.number, value)
      break
    case 'freeze':
      result = await teamAPI.freeze(key, value)
      break
    case 'unfreeze':
      result = await teamAPI.unfreeze(key)
      done = t('teamProject.dialogs.unfrozen')
      break
    case 'sendReference':
      // 「已发给 某某外包。」在推送做完时说（作业进度走导入挂件）
      result = await teamAPI.sendReference(key, {
        company: d.company.id,
        paths: d.paths,
        note: value
      })
      break
    default:
      return
  }
  busy.value = false
  if (!result.success) {
    error.value = failureText(result)
    return
  }
  if (done) message.success(done)
  closeTeamDialog(true)
  void teamStore.refresh()
}
</script>

<style scoped lang="less">
.team-dialog {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.team-dialog-body {
  margin: 0;
  color: var(--color-text-secondary);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);

  > span {
    color: var(--color-text-secondary);
    font-size: var(--font-size-sm);
  }
}

.team-dialog-error {
  color: var(--color-danger-text);
  font-size: var(--font-size-sm);
}
</style>
