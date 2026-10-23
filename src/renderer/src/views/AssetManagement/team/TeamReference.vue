<template>
  <div class="team-page team-reference" data-testid="team-reference">
    <div v-if="loading" class="skeleton-rows"><span class="skeleton-card" /></div>
    <div v-else-if="items.length === 0" class="page-state">{{ t('teamProject.history.none') }}</div>
    <div v-for="item in items" :key="item.id" class="row-card">
      <span class="row-text">
        <span class="muted">
          {{
            t('teamProject.outsource.sentBy', {
              who: item.by.name,
              time: formatTeamTime(item.at, now, t)
            })
          }}
        </span>
        <br />
        {{ item.note }}
      </span>
      <span class="muted">{{ pathsLabel(item.paths, t) }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 外包 › 某某外包 › 参考（管理员看）：发过去的每一批和当时那句话（方案 4.13）。
 * 发参考本身在网格或文件夹树的右键「发给外包 ▸ 某某外包」。
 */
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TeamReference } from '@core/shared/teamProject'
import { teamAPI } from '@renderer/api/team'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import { formatTeamTime, pathsLabel } from './teamFormat'

const { t } = useI18n()
const teamStore = useTeamStore()
const items = ref<TeamReference[]>([])
const loading = ref(false)
const now = ref(Date.now())

async function load(): Promise<void> {
  const key = teamStore.key
  if (!key) return
  loading.value = true
  now.value = Date.now()
  try {
    const result = await teamAPI.references(key)
    const company = teamStore.params.companyId
    items.value = result.items
      .filter((item) => !company || !item.company || item.company === company)
      .sort((a, b) => b.at - a.at)
  } catch {
    items.value = []
  } finally {
    loading.value = false
  }
}

watch(
  () => [teamStore.params.companyId, teamStore.revision],
  () => void load()
)
onMounted(() => void load())
</script>

<style scoped lang="less">
@import './teamPage.less';

.muted {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}
</style>
