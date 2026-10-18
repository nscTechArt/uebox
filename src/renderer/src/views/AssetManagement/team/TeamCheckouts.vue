<template>
  <div class="team-page team-checkouts" data-testid="team-checkouts">
    <div v-if="loading && groups.length === 0" class="skeleton-rows">
      <span v-for="n in 3" :key="n" class="skeleton-card" />
    </div>
    <div v-else-if="error" class="page-state">
      {{ t('teamProject.activity.error') }}
      <AppButton size="small" @click="load">{{ t('teamProject.retry') }}</AppButton>
    </div>
    <div v-else-if="groups.length === 0" class="page-state">
      {{ t('teamProject.checkouts.empty') }}
    </div>

    <!-- 按人分组：「阿杰 · 12 个 · 在线」；最早超过 3 天加琥珀色「最早 5 天」；管理员 [全部收回] -->
    <section v-for="group in groups" :key="group.holder.id" class="checkout-group">
      <div class="group-title">
        <TeamAvatar :name="group.holder.name" :online="group.holder.online" size="small" />
        <span>{{
          t('teamProject.checkouts.groupTitle', { who: group.holder.name, n: group.count })
        }}</span>
        <span
          v-if="group.holder.id !== teamStore.me && personState(group.holder, now, t)"
          class="muted"
        >
          · {{ personState(group.holder, now, t) }}
        </span>
        <span v-if="now - group.oldestSince > THREE_DAYS" class="oldest">
          {{
            t('teamProject.checkouts.oldest', {
              duration: formatDuration(now - group.oldestSince, t)
            })
          }}
        </span>
        <AppButton
          v-if="teamStore.isAdmin && group.holder.id !== teamStore.me"
          size="small"
          class="take-back-all"
          @click="takeBackAll(group)"
        >
          {{ t('teamProject.checkouts.takeBackAll') }}
        </AppButton>
      </div>
      <div class="card-grid">
        <div
          v-for="card in cardsOf(group)"
          :key="card.key"
          class="asset-card"
          :title="card.paths[0]"
          @click="emit('open-path', card.previewPath, null)"
          @contextmenu.prevent="openMenu($event, group, card.paths)"
        >
          <div class="thumb-box">
            <img v-if="previews[card.previewPath]" :src="previews[card.previewPath] ?? ''" alt="" />
            <TeamThumb v-else :hash="null" :path="card.previewPath" size="large" />
          </div>
          <div class="card-name">{{ card.name }}</div>
          <div class="card-sub">{{ formatDuration(now - card.since, t) }}</div>
        </div>
      </div>
    </section>

    <!-- 右键：管理员「收回」；其他人「问他改完没」 -->
    <ContextMenu ref="menuRef" :menu-items="menuItems" @click="onMenu" />
  </div>
</template>

<script setup lang="ts">
/**
 * 签出中（方案 4.9）：现有网格样式，按人分组；你自己的组在最上面，其他人按最早一次签出从久到新
 * （服务端已排好）。Actor 的签出按地图合成一张卡「L_North · 2 块」。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppButton from '@renderer/components/AppButton.vue'
import { ContextMenu, type MenuItem } from '@renderer/components/ContextMenu'
import type { TeamCheckoutGroup } from '@core/shared/teamProject'
import { teamAPI } from '@renderer/api/team'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import TeamAvatar from './TeamAvatar.vue'
import TeamThumb from './TeamThumb.vue'
import { assetNameOf, formatDuration, ofpaGroups, personState } from './teamFormat'
import { catalogRowByPath } from './teamAssets'
import { openTeamDialog } from './teamDialogs'
import { useTeamAsset } from './useTeamAsset'

const THREE_DAYS = 3 * 24 * 60 * 60 * 1000
const emit = defineEmits<{ (e: 'open-path', path: string, hash: string | null): void }>()
const { t } = useI18n()
const teamStore = useTeamStore()
const teamAsset = useTeamAsset()

const groups = ref<TeamCheckoutGroup[]>([])
const loading = ref(false)
const error = ref(false)
const now = ref(Date.now())
const previews = reactive<Record<string, string | null>>({})
const menuRef = ref<{ show: (x: number, y: number) => void } | null>(null)
const menuTarget = ref<{ group: TeamCheckoutGroup; paths: string[] } | null>(null)

function cardsOf(
  group: TeamCheckoutGroup
): Array<{ key: string; name: string; since: number; paths: string[]; previewPath: string }> {
  return ofpaGroups(group.items).map((entry) =>
    entry.map
      ? {
          key: `map:${entry.map}`,
          name: t('teamProject.checkouts.mapCard', {
            map: assetNameOf(entry.map),
            n: entry.items.length
          }),
          since: Math.min(...entry.items.map((item) => item.since)),
          paths: entry.items.map((item) => item.path),
          // Actor 的缩略图用所在地图的
          previewPath: entry.map
        }
      : {
          key: entry.items[0].path,
          name: assetNameOf(entry.items[0].path),
          since: entry.items[0].since,
          paths: [entry.items[0].path],
          previewPath: entry.items[0].path
        }
  )
}

async function load(): Promise<void> {
  const key = teamStore.key
  if (!key) return
  now.value = Date.now()
  loading.value = true
  error.value = false
  try {
    const result = await teamAPI.checkouts(key)
    // 你自己的组在最上面
    groups.value = [...result.groups].sort((a, b) =>
      a.holder.id === teamStore.me ? -1 : b.holder.id === teamStore.me ? 1 : 0
    )
    for (const group of result.groups)
      for (const card of cardsOf(group)) {
        const path = card.previewPath
        if (path in previews) continue
        previews[path] = null
        void catalogRowByPath(key, path).then((row) => {
          previews[path] = row?.previewUrl ?? null
        })
      }
  } catch {
    error.value = true
  } finally {
    loading.value = false
  }
}

async function takeBackAll(group: TeamCheckoutGroup): Promise<void> {
  const done = await openTeamDialog({
    kind: 'takeBack',
    holder: { id: group.holder.id, name: group.holder.name },
    count: group.count
  })
  if (done) void load()
}

const menuItems = computed<MenuItem[]>(() => {
  const target = menuTarget.value
  if (!target || target.group.holder.id === teamStore.me) return []
  if (teamStore.isAdmin) return [{ key: 'take-back', label: t('teamProject.history.takeBack') }]
  const asked = teamAsset.askedLabel(target.paths[0])
  return [
    { key: 'ask', label: asked ?? t('teamProject.history.askDone'), disabled: Boolean(asked) }
  ]
})

function openMenu(event: MouseEvent, group: TeamCheckoutGroup, paths: string[]): void {
  menuTarget.value = { group, paths }
  if (menuItems.value.length === 0) return
  menuRef.value?.show(event.clientX, event.clientY)
}

async function onMenu(key: string): Promise<void> {
  const target = menuTarget.value
  if (!target) return
  if (key === 'take-back') {
    const done = await openTeamDialog({
      kind: 'takeBack',
      holder: { id: target.group.holder.id, name: target.group.holder.name },
      paths: target.paths,
      count: target.paths.length > 1 ? target.paths.length : 1
    })
    if (done) void load()
  }
  if (key === 'ask') await teamAsset.ask(target.paths)
}

watch(
  () => teamStore.revision,
  () => void load()
)
onMounted(() => void load())
</script>

<style scoped lang="less">
@import './teamPage.less';

.checkout-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.group-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-primary);
}

.muted {
  color: var(--color-text-muted);
}

.oldest {
  color: var(--color-warning-text);
  font-size: var(--font-size-sm);
}

.take-back-all {
  margin-left: auto;
}

.thumb-box {
  aspect-ratio: 1;
  overflow: hidden;
  border-radius: var(--radius-sm);
  background: var(--color-bg-sunken);

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
}
</style>
