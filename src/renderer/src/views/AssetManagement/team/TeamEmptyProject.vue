<template>
  <!-- 空工程（方案 4.3）：管理员「工程还是空的。」[放入电脑上的工程]；其他人「工程还是空的，等管理员放进来。」 -->
  <div class="team-empty" data-testid="team-empty-project">
    <template v-if="teamStore.isAdmin">
      <p>{{ t('teamProject.putIn.empty') }}</p>
      <AppButton variant="primary" @click="open = true">{{
        t('teamProject.putIn.action')
      }}</AppButton>
    </template>
    <p v-else>{{ t('teamProject.putIn.emptyWait') }}</p>
  </div>

  <AppModal
    :open="open"
    :title="t('teamProject.putIn.title', { name: projectName })"
    :width="460"
    :ok-text="t('teamProject.putIn.start')"
    :cancel-text="t('teamProject.cancel')"
    :ok-disabled="!source || !uproject || busy"
    :confirm-loading="busy"
    destroy-on-close
    @ok="start"
    @update:open="(value: boolean) => !value && (open = false)"
  >
    <div class="put-in-body">
      <div class="place-row">
        <span class="muted">{{ t('teamProject.putIn.from') }}</span>
        <button class="place-btn" @click="pick">{{ source || t('teamProject.putIn.pick') }}</button>
      </div>
      <div v-if="source && !uproject" class="warn-line">
        {{ t('teamProject.putIn.notProject') }}
      </div>
      <div class="muted">{{ t('teamProject.putIn.hint') }}</div>
    </div>
  </AppModal>
</template>

<script setup lang="ts">
/**
 * 放入电脑上的工程（只有管理员）：选 .uproject 所在的文件夹，传上去就是 #1；
 * 这个文件夹就是本机同步好的那一份，不用再下载。进度走导入进度挂件「放入 星海 · 42%」。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppButton from '@renderer/components/AppButton.vue'
import AppModal from '@renderer/components/AppModal.vue'
import { teamAPI } from '@renderer/api/team'
import { catalogLibraryAPI } from '@renderer/api/catalogLibrary'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import { message } from '@renderer/utils/messageManager'

const { t } = useI18n()
const teamStore = useTeamStore()
const open = ref(false)
const source = ref('')
const uproject = ref<string | null>(null)
const busy = ref(false)
const projectName = computed(() => teamStore.project?.name ?? teamStore.link?.projectName ?? '')

async function pick(): Promise<void> {
  const result = await catalogLibraryAPI.pickFolder()
  if (!result.success || !result.data) return
  source.value = result.data
  uproject.value = (await teamAPI.inspectFolder(result.data).catch(() => null))?.uproject ?? null
}

async function start(): Promise<void> {
  const key = teamStore.key
  if (!key || !source.value) return
  busy.value = true
  const result = await teamAPI.putIn(key, source.value)
  busy.value = false
  if (!result.success) {
    message.error(t('teamProject.dialogs.failed'))
    return
  }
  open.value = false
}
</script>

<style scoped lang="less">
.team-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  color: var(--color-text-secondary);

  p {
    margin: 0;
  }
}

.put-in-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.place-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.place-btn {
  flex: 1;
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-surface);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
}

.muted {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.warn-line {
  color: var(--color-danger-text);
  font-size: var(--font-size-sm);
}
</style>
