<template>
  <div class="team-page team-deleted" data-testid="team-deleted">
    <div v-if="loading && items.length === 0" class="card-grid">
      <span v-for="n in 4" :key="n" class="skeleton-card" />
    </div>
    <div v-else-if="error" class="page-state">
      {{ t('teamProject.activity.error') }}
      <AppButton size="small" @click="load">{{ t('teamProject.retry') }}</AppButton>
    </div>
    <div v-else-if="items.length === 0" class="page-state">
      {{ t('teamProject.deleted.empty') }}
    </div>
    <div v-else class="card-grid">
      <div
        v-for="item in items"
        :key="item.path"
        class="asset-card"
        :class="{ selected: selected === item.path }"
        :title="item.path"
        @click="selected = item.path"
        @contextmenu.prevent="openMenu($event, item)"
      >
        <TeamThumb :hash="item.hash" :path="item.path" deleted size="large" />
        <div class="card-name">{{ assetNameOf(item.path) }}</div>
        <!-- 「阿杰 删的 · 昨天 · #1519」 -->
        <div class="card-sub">
          {{
            t('teamProject.deleted.subtitle', {
              who: item.author.name,
              time: formatTeamTime(item.at, now, t),
              n: item.number
            })
          }}
        </div>
        <AppButton
          v-if="selected === item.path && teamStore.isLocal"
          size="small"
          variant="primary"
          :loading="restoring === item.path"
          @click.stop="restore(item)"
        >
          {{ t('teamProject.deleted.restore') }}
        </AppButton>
      </div>
    </div>
    <ContextMenu ref="menuRef" :menu-items="menuItems" @click="onMenu" />
  </div>
</template>

<script setup lang="ts">
/**
 * 最近删除（方案 4.10）：最近 30 天里被提交删掉的文件，按删除时间排；没有「清空」。
 * [恢复] 和「回到这一版」一样：在你电脑上放回（回到删之前最后存在的那一版），提交后别人才拿到。
 * 工程不在你电脑上时没有 [恢复]。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppButton from '@renderer/components/AppButton.vue'
import { ContextMenu, type MenuItem } from '@renderer/components/ContextMenu'
import type { TeamDeletedItem } from '@core/shared/teamProject'
import { teamAPI } from '@renderer/api/team'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import { message } from '@renderer/utils/messageManager'
import TeamThumb from './TeamThumb.vue'
import { assetNameOf, formatTeamTime } from './teamFormat'
import { loadFacts } from './teamFacts'

const { t } = useI18n()
const teamStore = useTeamStore()

const items = ref<TeamDeletedItem[]>([])
const loading = ref(false)
const error = ref(false)
const selected = ref<string | null>(null)
const restoring = ref<string | null>(null)
const now = ref(Date.now())
const menuRef = ref<{ show: (x: number, y: number) => void } | null>(null)
const menuTarget = ref<TeamDeletedItem | null>(null)

const menuItems = computed<MenuItem[]>(() =>
  teamStore.isLocal ? [{ key: 'restore', label: t('teamProject.deleted.restore') }] : []
)

async function load(): Promise<void> {
  const key = teamStore.key
  if (!key) return
  now.value = Date.now()
  loading.value = true
  error.value = false
  try {
    const result = await teamAPI.deleted(key, 30)
    items.value = [...result.items].sort((a, b) => b.at - a.at)
    void loadFacts(
      key,
      items.value.map((item) => item.hash)
    )
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
}

async function restore(item: TeamDeletedItem): Promise<void> {
  const key = teamStore.key
  if (!key) return
  restoring.value = item.path
  const result = await teamAPI.restore(key, item.path, item.restoreFrom)
  restoring.value = null
  if (!result.success) {
    message.error(t('teamProject.dialogs.failed'))
    return
  }
  message.success(t('teamProject.deleted.restored', { name: assetNameOf(item.path) }))
}

function openMenu(event: MouseEvent, item: TeamDeletedItem): void {
  selected.value = item.path
  menuTarget.value = item
  if (menuItems.value.length > 0) menuRef.value?.show(event.clientX, event.clientY)
}

function onMenu(key: string): void {
  if (key === 'restore' && menuTarget.value) void restore(menuTarget.value)
}

watch(
  () => teamStore.revision,
  () => void load()
)
onMounted(() => void load())
</script>

<style scoped lang="less">
@import './teamPage.less';
</style>
