<template>
  <div class="team-page team-activity" data-testid="team-activity">
    <!-- 汇总一行：「本周 186 次提交 · 美术组 112 · 策划组 41 · 程序组 33」[本周 ▾] [冻结]（管理员，冻结中不显示） -->
    <div class="summary-row">
      <span v-if="summary" class="summary-text">
        {{
          t('teamProject.activity.summary', {
            period: t(`teamProject.activity.periods.${period}`),
            n: summary.total
          })
        }}
        <template v-for="group in summary.byGroup" :key="group.group">
          · {{ group.group }} {{ group.n }}
        </template>
      </span>
      <span v-else class="skeleton-block" />
      <AppDropdown placement="bottomLeft">
        <button class="pill-btn">
          {{ t(`teamProject.activity.periods.${period}`) }} <PhCaretDown />
        </button>
        <template #overlay>
          <AppMenu :selected-keys="[period]" @click="(info) => setPeriod(info.key)">
            <AppMenuItem v-for="p in PERIODS" :key="p" :item-key="p">
              {{ t(`teamProject.activity.periods.${p}`) }}
            </AppMenuItem>
          </AppMenu>
        </template>
      </AppDropdown>
      <AppButton
        v-if="teamStore.isAdmin && !teamStore.frozen"
        size="small"
        class="freeze-btn"
        data-testid="team-freeze"
        @click="openTeamDialog({ kind: 'freeze' })"
      >
        {{ t('teamProject.activity.freeze') }}
      </AppButton>
    </div>

    <!-- 按需：签出超过 3 天的，最多 3 人，多了写「等 5 人」 -->
    <div v-if="summary && summary.longCheckouts.length > 0" class="long-row">
      {{ t('teamProject.activity.longCheckouts')
      }}<template v-for="(item, index) in summary.longCheckouts.slice(0, 3)" :key="item.holder.id"
        ><span v-if="index > 0"> · </span
        >{{
          t('teamProject.activity.longItem', {
            who: item.holder.name,
            label: item.label,
            duration: formatDuration(now - item.oldestSince, t)
          })
        }}</template
      ><template v-if="summary.longCheckouts.length > 3">
        · {{ t('teamProject.activity.longMore', { n: summary.longCheckouts.length }) }}</template
      >
    </div>

    <!-- 工具条：[谁 ▾] [文件夹 ▾] [只看里程碑] [对比] -->
    <div class="toolbar-row">
      <AppDropdown placement="bottomLeft">
        <button class="pill-btn" :class="{ active: who }">{{ whoLabel }} <PhCaretDown /></button>
        <template #overlay>
          <AppMenu :selected-keys="[who ?? '']" @click="(info) => setWho(info.key)">
            <AppMenuItem item-key="">{{ t('teamProject.activity.everyone') }}</AppMenuItem>
            <AppMenuDivider v-if="groups.length > 0" />
            <AppMenuItem v-for="g in groups" :key="`group:${g}`" :item-key="`group:${g}`">
              {{ g }}
            </AppMenuItem>
            <AppMenuDivider />
            <AppMenuItem v-for="p in people" :key="p.id" :item-key="p.id">{{ p.name }}</AppMenuItem>
          </AppMenu>
        </template>
      </AppDropdown>
      <AppDropdown placement="bottomLeft">
        <button class="pill-btn" :class="{ active: folder }">
          {{ folder || t('teamProject.activity.folder') }} <PhCaretDown />
        </button>
        <template #overlay>
          <AppMenu :selected-keys="[folder ?? '']" @click="(info) => setFolder(info.key)">
            <AppMenuItem item-key="">{{ t('teamProject.activity.allFolders') }}</AppMenuItem>
            <AppMenuItem v-for="f in folders" :key="f" :item-key="f">{{ f }}</AppMenuItem>
          </AppMenu>
        </template>
      </AppDropdown>
      <button class="pill-btn" :class="{ active: onlyMilestones }" @click="toggleMilestones">
        {{ t('teamProject.activity.onlyMilestones') }}
      </button>
      <button class="pill-btn" data-testid="team-open-compare" @click="openCompare">
        {{ t('teamProject.activity.compare') }}
      </button>
    </div>

    <!-- 列表：按天分组的提交卡片 -->
    <div v-if="loading && items.length === 0" class="skeleton-rows">
      <span v-for="n in 5" :key="n" class="skeleton-card" />
    </div>
    <div v-else-if="error" class="page-state">
      {{ offlineText ?? t('teamProject.activity.error') }}
      <AppButton v-if="!offlineText" size="small" @click="reload">{{
        t('teamProject.retry')
      }}</AppButton>
    </div>
    <div v-else-if="items.length === 0" class="page-state">
      {{ t('teamProject.activity.empty') }}
    </div>
    <template v-else>
      <section v-for="day in days" :key="day.key" class="day-group">
        <div class="day-title">{{ day.title }}</div>
        <SubmitCard
          v-for="submit in day.items"
          :key="submit.number"
          :submit="submit"
          :now="now"
          :initially-expanded="expandNumber === submit.number"
          :previous-milestone="previousMilestoneOf(submit.number)"
          @changed="reload"
          @compare-from="(n) => teamStore.openView('compare', { from: n, to: 'latest' })"
          @compare-range="(from, to) => teamStore.openView('compare', { from, to })"
        />
      </section>
      <div v-if="nextCursor" class="load-more">
        <AppButton size="small" :loading="loading" @click="loadMore">
          {{ t('teamProject.activity.loadMore') }}
        </AppButton>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 动态（方案 5.11，盒子里同一页 4.8）：汇总一行、按需的「签出超过 3 天」、工具条、按天分组的提交卡片。
 * 搜索用工具栏现有的搜索框（teamStore.query）；输入「#1532」直接展开那一条。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCaretDown } from '@phosphor-icons/vue'
import AppButton from '@renderer/components/AppButton.vue'
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import AppMenuDivider from '@renderer/components/AppMenuDivider.vue'
import type { TeamActivitySummary, TeamSubmit } from '@core/shared/teamProject'
import { teamAPI } from '@renderer/api/team'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import { getActiveLibrarySource } from '../data/activeLibrarySource'
import SubmitCard from './SubmitCard.vue'
import { dayGroupTitle, dayKey, formatDuration, formatTeamTime } from './teamFormat'
import { loadFacts } from './teamFacts'
import { openTeamDialog } from './teamDialogs'

const PERIODS = ['week', 'lastWeek', 'month'] as const
type Period = (typeof PERIODS)[number]

const { t } = useI18n()
const teamStore = useTeamStore()

const summary = ref<TeamActivitySummary | null>(null)
const items = ref<TeamSubmit[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const period = ref<Period>('week')
const who = ref<string | null>(null)
const folder = ref<string | null>(null)
const onlyMilestones = ref(false)
const folders = ref<string[]>([])
const now = ref(Date.now())
const expandNumber = ref<number | null>(teamStore.params.expand ?? null)

const people = computed(() => (teamStore.project?.people ?? []).filter((p) => p.role !== 'build'))
const groups = computed(() => [
  ...new Set(people.value.map((p) => p.group).filter((g): g is string => Boolean(g)))
])
const whoLabel = computed(() => {
  if (!who.value) return t('teamProject.activity.who')
  if (who.value.startsWith('group:')) return who.value.slice(6)
  return people.value.find((p) => p.id === who.value)?.name ?? who.value
})
const offlineText = computed(() =>
  error.value === 'unreachable' && teamStore.offlineSince
    ? t('teamProject.activity.offline', {
        time: formatTeamTime(teamStore.offlineSince, now.value, t)
      })
    : null
)

/** 本周 / 上周 / 本月 → [since, until) */
function range(p: Period): { since: number; until?: number } {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  const monday = new Date(d)
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  if (p === 'week') return { since: monday.getTime() }
  if (p === 'lastWeek') {
    const last = new Date(monday)
    last.setDate(monday.getDate() - 7)
    return { since: last.getTime(), until: monday.getTime() }
  }
  return { since: new Date(d.getFullYear(), d.getMonth(), 1).getTime() }
}

function queryArgs(): Record<string, unknown> {
  const q = teamStore.query.trim()
  return {
    limit: 50,
    q: q || undefined,
    author: who.value && !who.value.startsWith('group:') ? who.value : undefined,
    group: who.value?.startsWith('group:') ? who.value.slice(6) : undefined,
    folder: folder.value ?? undefined,
    milestones: onlyMilestones.value || undefined,
    state: teamStore.params.pendingOnly ? 'pending' : undefined
  }
}

async function loadSummary(): Promise<void> {
  const key = teamStore.key
  if (!key) return
  const { since, until } = range(period.value)
  summary.value = await teamAPI.summary(key, since, until).catch(() => null)
}

async function reload(): Promise<void> {
  const key = teamStore.key
  if (!key) return
  now.value = Date.now()
  loading.value = true
  error.value = null
  try {
    const page = await teamAPI.submits(key, queryArgs())
    items.value = page.items
    nextCursor.value = page.nextCursor
    void loadFacts(
      key,
      page.items.flatMap((item) => item.preview)
    )
    // 输入「#1532」直接展开那一条
    const number = /^#?(\d+)$/.exec(teamStore.query.trim())?.[1]
    if (number) expandNumber.value = Number(number)
    if (expandNumber.value !== null) {
      await nextTick()
      document
        .querySelector(`.team-activity [data-submit="${expandNumber.value}"]`)
        ?.scrollIntoView({ block: 'center' })
    }
  } catch (err) {
    error.value = (err as { code?: string }).code ?? 'unknown'
  } finally {
    loading.value = false
  }
  void loadSummary()
}

async function loadMore(): Promise<void> {
  const key = teamStore.key
  if (!key || !nextCursor.value) return
  loading.value = true
  try {
    const page = await teamAPI.submits(key, { ...queryArgs(), cursor: nextCursor.value })
    items.value = [...items.value, ...page.items]
    nextCursor.value = page.nextCursor
    void loadFacts(
      key,
      page.items.flatMap((item) => item.preview)
    )
  } finally {
    loading.value = false
  }
}

const days = computed(() => {
  const out: Array<{ key: number; title: string; items: TeamSubmit[] }> = []
  for (const item of items.value) {
    const k = dayKey(item.at)
    let group = out.find((day) => day.key === k)
    if (!group) {
      group = { key: k, title: dayGroupTitle(item.at, now.value, t), items: [] }
      out.push(group)
    }
    group.items.push(item)
  }
  return out
})

/** 里程碑卡片的 [和上一个里程碑对比] */
function previousMilestoneOf(number: number): number | null {
  const older = teamStore.milestones
    .filter((m) => m.number < number)
    .sort((a, b) => b.number - a.number)
  return older[0]?.number ?? null
}

function setPeriod(key: string): void {
  period.value = (PERIODS as readonly string[]).includes(key) ? (key as Period) : 'week'
  void loadSummary()
}
function setWho(key: string): void {
  who.value = key || null
  void reload()
}
function setFolder(key: string): void {
  folder.value = key || null
  void reload()
}
function toggleMilestones(): void {
  onlyMilestones.value = !onlyMilestones.value
  void reload()
}

/** [对比]：默认从最近一个里程碑到最新 */
function openCompare(): void {
  const latestMilestone = teamStore.milestones[0]
  teamStore.openView('compare', { from: latestMilestone?.number ?? null, to: 'latest' })
}

async function loadFolders(): Promise<void> {
  const rows = await getActiveLibrarySource()
    .folders.getByFatherKey('ALL')
    .catch(() => [])
  const top = rows.map((row) =>
    String((row as { catalogPath?: string }).catalogPath ?? row.folderName)
  )
  const second: string[] = []
  for (const row of rows.slice(0, 8)) {
    const children = await getActiveLibrarySource()
      .folders.getByFatherKey(row.folderKey)
      .catch(() => [])
    for (const child of children)
      second.push(String((child as { catalogPath?: string }).catalogPath ?? child.folderName))
  }
  folders.value = [...top, ...second].sort()
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(
  () => teamStore.query,
  () => {
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => void reload(), 300)
  }
)
watch(
  () => teamStore.revision,
  () => {
    expandNumber.value = teamStore.params.expand ?? expandNumber.value
    void reload()
  }
)

onMounted(() => {
  void reload()
  void loadFolders()
})
</script>

<style scoped lang="less">
@import './teamPage.less';

.summary-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-primary);
}

.summary-text {
  font-size: var(--font-size-md);
}

.freeze-btn {
  margin-left: auto;
}

.long-row {
  color: var(--color-warning-text);
  font-size: var(--font-size-sm);
}

.toolbar-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.day-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.day-title {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  margin-top: var(--space-2);
}

.load-more {
  display: flex;
  justify-content: center;
}
</style>
