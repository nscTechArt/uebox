<template>
  <div class="team-center">
    <TeamActivity v-if="teamStore.view === 'activity'" :key="`a${teamStore.key}`" />
    <TeamCompare
      v-else-if="teamStore.view === 'compare'"
      :key="`c${teamStore.key}${String(teamStore.params.from)}${String(teamStore.params.to)}`"
      @open-path="(path) => emit('open-path', path)"
    />
    <TeamBisect
      v-else-if="teamStore.view === 'bisect'"
      :key="`b${teamStore.key}${teamStore.params.bisectId ?? ''}${teamStore.params.good ?? ''}`"
    />
    <TeamCheckouts
      v-else-if="teamStore.view === 'checkouts'"
      :key="`k${teamStore.key}`"
      @open-path="(path) => emit('open-path', path)"
    />
    <TeamInbox v-else-if="teamStore.view === 'inbox'" :key="`i${teamStore.key}`" />
    <TeamDeleted v-else-if="teamStore.view === 'deleted'" :key="`d${teamStore.key}`" />
    <TeamDelivery v-else-if="teamStore.view === 'delivery'" :key="`v${teamStore.key}`" />
    <TeamReference v-else-if="teamStore.view === 'reference'" :key="`r${teamStore.key}`" />
  </div>
</template>

<script setup lang="ts">
/**
 * 团队工程在资产库中间区域的几页（方案 4.8–4.11、4.13）：动态、对比、找坏提交、签出中、
 * 等你处理、最近删除、收交付。和网格同一块地方；点左栏文件夹就回到网格。
 */
import { useTeamStore } from '@renderer/store/modules/teamStore'
import TeamActivity from './TeamActivity.vue'
import TeamBisect from './TeamBisect.vue'
import TeamCheckouts from './TeamCheckouts.vue'
import TeamCompare from './TeamCompare.vue'
import TeamDeleted from './TeamDeleted.vue'
import TeamDelivery from './TeamDelivery.vue'
import TeamInbox from './TeamInbox.vue'
import TeamReference from './TeamReference.vue'

const emit = defineEmits<{ (e: 'open-path', path: string): void }>()
const teamStore = useTeamStore()
</script>

<style scoped lang="less">
.team-center {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
