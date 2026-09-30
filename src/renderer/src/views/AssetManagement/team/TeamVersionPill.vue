<template>
  <span v-if="show" class="team-version-pills">
    <!-- 「主线 ▾」：2 条以上分支才出现，放在「最新 ▾」左边；切换的是浏览哪条分支，不影响本机工程 -->
    <AppDropdown v-if="branches.length >= 2" placement="bottomRight">
      <button class="pill">{{ t('teamProject.versions.mainline') }} <PhCaretDown /></button>
      <template #overlay>
        <AppMenu :selected-keys="['main']">
          <AppMenuItem v-for="b in branches" :key="b.name" :item-key="b.name">{{
            b.name
          }}</AppMenuItem>
        </AppMenu>
      </template>
    </AppDropdown>
    <!-- 「最新 ▾」：有了第一个里程碑，或者在历史里点过「看这一版」之后才出现；选了旧的胶囊变蓝 -->
    <TeamVersionSelect
      v-if="teamStore.milestones.length > 0 || teamStore.viewingOld"
      :model-value="teamStore.viewingOld?.number ?? 'latest'"
      :milestones="teamStore.milestones"
      highlight-old
      @update:model-value="pick"
    />
  </span>
</template>

<script setup lang="ts">
/** 面包屑右端按需出现的两个胶囊（方案 4.5） */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCaretDown } from '@phosphor-icons/vue'
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import TeamVersionSelect from './TeamVersionSelect.vue'

const { t } = useI18n()
const teamStore = useTeamStore()
const branches = computed(() => teamStore.project?.branches ?? [])
const show = computed(
  () =>
    teamStore.isTeam &&
    !teamStore.isOutsourcer &&
    (branches.value.length >= 2 || teamStore.milestones.length > 0 || Boolean(teamStore.viewingOld))
)

function pick(value: number | 'latest'): void {
  if (value === 'latest') {
    teamStore.viewingOld = null
    return
  }
  const milestone = teamStore.milestones.find((m) => m.number === value)
  teamStore.viewingOld = { name: milestone?.name ?? null, number: value }
}
</script>

<style scoped lang="less">
.team-version-pills {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
  flex-shrink: 0;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-bg-surface);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}
</style>
