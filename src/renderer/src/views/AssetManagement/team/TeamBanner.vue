<template>
  <!-- 横幅（方案 2.11）：一次一条。连不上 > 在看旧版 > 冻结中 > 工程不在本机 -->
  <div v-if="banner" class="team-banner" :class="`tone-${banner.tone}`" data-testid="team-banner">
    <span class="banner-text">
      {{ banner.text }}
      <button
        v-if="banner.kind === 'frozen' && waiting > 0"
        class="banner-link"
        @click="showWaiting"
      >
        {{ t('teamProject.banner.waiting', { n: waiting }) }}
      </button>
    </span>
    <AppButton
      v-if="banner.kind === 'old'"
      size="small"
      variant="link"
      @click="teamStore.viewingOld = null"
    >
      {{ t('teamProject.banner.backToLatest') }}
    </AppButton>
    <AppButton v-if="banner.kind === 'frozen' && teamStore.isAdmin" size="small" @click="unfreeze">
      {{ t('teamProject.banner.unfreeze') }}
    </AppButton>
    <AppButton
      v-if="banner.kind === 'notLocal'"
      size="small"
      variant="primary"
      data-testid="team-sync-to-local"
      @click="syncOpen = true"
    >
      {{ t('teamProject.banner.syncToLocal') }}
    </AppButton>
    <AppButton
      v-if="banner.kind === 'ready' && teamStore.local?.uproject"
      size="small"
      @click="openInUe"
    >
      {{ t('teamProject.banner.openInUe') }}
    </AppButton>
  </div>
  <TeamSyncModal :open="syncOpen" @close="syncOpen = false" />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppButton from '@renderer/components/AppButton.vue'
import { teamAPI } from '@renderer/api/team'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import { message } from '@renderer/utils/messageManager'
import TeamSyncModal from './TeamSyncModal.vue'
import { formatTeamTime } from './teamFormat'
import { openTeamDialog } from './teamDialogs'

const { t } = useI18n()
const teamStore = useTeamStore()
const syncOpen = ref(false)

const waiting = computed(() => teamStore.frozen?.waiting ?? 0)

type Banner = {
  kind: 'offline' | 'old' | 'frozen' | 'notLocal' | 'ready'
  tone: 'grey' | 'blue' | 'amber'
  text: string
}

const banner = computed<Banner | null>(() => {
  if (!teamStore.isTeam) return null
  const now = Date.now()
  if (teamStore.offlineSince !== null)
    return {
      kind: 'offline',
      tone: 'grey',
      text: t('teamProject.banner.offline', {
        time: formatTeamTime(teamStore.offlineSince, now, t)
      })
    }
  const old = teamStore.viewingOld
  if (old)
    return {
      kind: 'old',
      tone: 'blue',
      text: old.name
        ? t('teamProject.banner.viewingOld', { name: old.name, number: old.number })
        : t('teamProject.banner.viewingNumber', { number: old.number })
    }
  const freeze = teamStore.frozen
  if (freeze)
    return {
      kind: 'frozen',
      tone: 'amber',
      text: t('teamProject.banner.frozen', { note: freeze.note })
    }
  if (teamStore.isOutsourcer || !teamStore.project || teamStore.isEmpty) return null
  if (teamStore.justSynced && teamStore.isLocal)
    return { kind: 'ready', tone: 'grey', text: t('teamProject.banner.ready') }
  if (teamStore.local && !teamStore.local.exists)
    return { kind: 'notLocal', tone: 'grey', text: t('teamProject.banner.notLocal') }
  return null
})

/** 冻结横幅上「· 在等 3 个」：点它把动态筛成在等的那几个 */
function showWaiting(): void {
  teamStore.openView('activity', { pendingOnly: true })
}

/** 解冻：有提交在排队时先问；没有排队时直接解冻（方案 5.11） */
async function unfreeze(): Promise<void> {
  const key = teamStore.key
  if (!key) return
  if (waiting.value > 0) {
    await openTeamDialog({ kind: 'unfreeze', waiting: waiting.value })
    return
  }
  const result = await teamAPI.unfreeze(key)
  if (!result.success) {
    message.error(t('teamProject.dialogs.failed'))
    return
  }
  message.success(t('teamProject.dialogs.unfrozen'))
  void teamStore.refresh(['freeze'])
}

async function openInUe(): Promise<void> {
  const uproject = teamStore.local?.uproject
  if (!uproject) return
  const result = await teamAPI.openPath(uproject)
  if (result.success) teamStore.justSynced = false
}
</script>

<style scoped lang="less">
.team-banner {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--font-size-sm);

  &.tone-grey {
    background: var(--color-bg-soft);
    color: var(--color-text-secondary);
  }

  &.tone-blue {
    background: var(--color-accent-bg);
    color: var(--color-accent-text);
  }

  &.tone-amber {
    background: var(--color-warning-bg);
    color: var(--color-warning-text);
  }
}

.banner-text {
  flex: 1;
  min-width: 0;
}

.banner-link {
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  text-decoration: underline;
  cursor: pointer;
}
</style>
