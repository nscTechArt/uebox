<template>
  <TeamJoinModal
    :open="teamStore.joinOpen"
    :link="teamStore.joinLink"
    @close="teamStore.joinOpen = false"
    @joined="handleJoined"
  />
</template>

<script setup lang="ts">
/**
 * 挂在应用根上的团队部分：通知流的事件从这里接（不打开资产库也要能弹托盘），
 * 邀请链接「用虚幻盒子打开」直接弹「加入团队」—— 不经过新建资产库弹窗（方案 4.1 A）。
 */
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import TeamJoinModal from './TeamJoinModal.vue'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import { useAssetLibraryStore } from '@renderer/store/modules/assetLibraryStore'

const teamStore = useTeamStore()
const libraryStore = useAssetLibraryStore()
const router = useRouter()

onMounted(() => teamStore.init())

async function handleJoined(payload: { keys: string[]; openKey: string | null }): Promise<void> {
  teamStore.joinLink = null
  await libraryStore.loadServerLibraries()
  const key = payload.openKey ?? payload.keys[0]
  if (key) await libraryStore.activateServer(key)
  await router.push('/asset-management').catch(() => undefined)
  window.dispatchEvent(new CustomEvent('navigate-to-all-folder'))
}
</script>
