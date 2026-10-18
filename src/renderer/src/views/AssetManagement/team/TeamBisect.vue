<template>
  <div class="team-page team-bisect" data-testid="team-bisect">
    <div class="bisect-top">
      <h2 class="page-title">{{ t('teamProject.bisect.title') }}</h2>
      <button v-if="bisect && bisect.state === 'running'" class="link-btn" @click="stop">
        {{ t('teamProject.bisect.stop') }}
      </button>
    </div>

    <div v-if="loading" class="skeleton-rows"><span class="skeleton-card" /></div>
    <div v-else-if="error" class="page-state">
      {{ error }}
      <AppButton size="small" @click="init">{{ t('teamProject.retry') }}</AppButton>
    </div>

    <!-- 开始：「#1460 是好的 · #1532 是坏的 · 中间 72 次提交，大约 6 轮」[开始] -->
    <div v-else-if="!bisect" class="bisect-card">
      <p class="bisect-line">
        {{
          t('teamProject.bisect.startLine', { good, bad, n: between, rounds: roundsFor(between) })
        }}
      </p>
      <AppButton variant="primary" :loading="busy" data-testid="team-bisect-start" @click="start">
        {{ t('teamProject.bisect.start') }}
      </AppButton>
    </div>

    <!-- 每一轮 -->
    <div v-else-if="bisect.state === 'running' && bisect.current" class="bisect-card">
      <div class="try-row">
        <span class="try-number">{{
          t('teamProject.bisect.tryThis', { n: bisect.current.number })
        }}</span>
        <AppButton size="small" @click="copy(`#${bisect.current.number}`)">
          {{ t('teamProject.bisect.copyNumber') }}
        </AppButton>
      </div>
      <div class="muted">{{ bisect.current.author.name }} · {{ bisect.current.message }}</div>
      <div class="muted">{{ t('teamProject.bisect.inUe') }}</div>
      <!-- 打包机命令 ▸（默认折叠） -->
      <button class="link-btn" @click="showCommand = !showCommand">
        {{ t('teamProject.bisect.buildCmd') }} {{ showCommand ? '▾' : '▸' }}
      </button>
      <div v-if="showCommand" class="command-row">
        <code>{{ buildCommand }}</code>
        <AppButton size="small" @click="copy(buildCommand)">{{
          t('teamProject.bisect.copy')
        }}</AppButton>
      </div>
      <div class="verdict-row">
        <AppButton variant="primary" :loading="busy" @click="verdict('good')">{{
          t('teamProject.bisect.good')
        }}</AppButton>
        <AppButton danger :loading="busy" @click="verdict('bad')">{{
          t('teamProject.bisect.bad')
        }}</AppButton>
        <AppButton :loading="busy" @click="verdict('skip')">{{
          t('teamProject.bisect.skip')
        }}</AppButton>
      </div>
      <div class="bisect-foot">
        <button v-if="bisect.steps.length > 0" class="link-btn" @click="undo">
          {{ t('teamProject.bisect.undo') }}
        </button>
        <span class="muted">
          {{ t('teamProject.bisect.progress', { round: bisect.round, left: bisect.roundsLeft }) }}
        </span>
      </div>
    </div>

    <!-- 结果 -->
    <div v-else-if="bisect.state === 'found' && foundSubmit" class="bisect-card">
      <p class="bisect-line strong">
        {{
          t('teamProject.bisect.found', {
            n: foundSubmit.number,
            who: foundSubmit.author.name,
            message: foundSubmit.message
          })
        }}
      </p>
      <SubmitCard :submit="foundSubmit" :now="now" initially-expanded />
      <AppButton size="small" @click="copy(teamStore.webLink(`/bisect/${bisect.id}`))">
        {{ t('teamProject.bisect.copyLink') }}
      </AppButton>
    </div>
    <div v-else-if="bisect.state === 'ambiguous'" class="bisect-card">
      <p class="bisect-line strong">
        {{ t('teamProject.bisect.ambiguous', { from: ambiguousRange[0], to: ambiguousRange[1] }) }}
      </p>
      <SubmitCard
        v-for="submit in ambiguousSubmits"
        :key="submit.number"
        :submit="submit"
        :now="now"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 找出是哪次提交弄坏的（方案 5.13）：进度存在团队那边，链接发给别人能接着做，三端看到同一轮。
 * 开始的人开着这个工程的 UE 时，UE 自动切到要试的那一次（UE 插件收 bisect.try）。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppButton from '@renderer/components/AppButton.vue'
import type { TeamBisect, TeamSubmit } from '@core/shared/teamProject'
import { teamAPI } from '@renderer/api/team'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import { message } from '@renderer/utils/messageManager'
import SubmitCard from './SubmitCard.vue'
import { loadFacts } from './teamFacts'

const { t } = useI18n()
const teamStore = useTeamStore()

const bisect = ref<TeamBisect | null>(null)
const good = ref<number>(Number(teamStore.params.good ?? 0))
const bad = ref<number>(Number(teamStore.params.bad ?? 0))
const between = ref(0)
const loading = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const showCommand = ref(false)
const foundSubmit = ref<TeamSubmit | null>(null)
const ambiguousSubmits = ref<TeamSubmit[]>([])
const now = ref(Date.now())

/** 大约几轮：二分 */
function roundsFor(n: number): number {
  return Math.max(1, Math.ceil(Math.log2(Math.max(1, n) + 1)))
}

const buildCommand = computed(() =>
  bisect.value?.current ? `lore sync ${bisect.value.current.revision}` : ''
)
const ambiguousRange = computed(() => {
  const result = bisect.value?.result
  const numbers = result && 'numbers' in result ? [...result.numbers].sort((a, b) => a - b) : []
  return [numbers[0] ?? 0, numbers[numbers.length - 1] ?? 0]
})

async function copy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text).catch(() => undefined)
  message.success(t('teamProject.bisect.copied'))
}

async function showResult(next: TeamBisect): Promise<void> {
  bisect.value = next
  const key = teamStore.key
  if (!key) return
  const result = next.result
  if (next.state === 'found' && result && 'number' in result) {
    foundSubmit.value = await teamAPI.submit(key, result.number).catch(() => null)
    if (foundSubmit.value) void loadFacts(key, foundSubmit.value.preview)
  }
  if (next.state === 'ambiguous' && result && 'numbers' in result) {
    const list = await Promise.all(
      result.numbers.map((n) => teamAPI.submit(key, n).catch(() => null))
    )
    ambiguousSubmits.value = list.filter((item): item is NonNullable<typeof item> => item !== null)
  }
}

async function init(): Promise<void> {
  const key = teamStore.key
  if (!key) return
  loading.value = true
  error.value = null
  try {
    if (teamStore.params.bisectId) {
      await showResult(await teamAPI.bisect(key, teamStore.params.bisectId))
      return
    }
    // 同一范围已有进行中的就接着做
    const running = await teamAPI.bisects(key).catch(() => ({ items: [] as TeamBisect[] }))
    const same = running.items.find((item) => item.good === good.value && item.bad === bad.value)
    if (same) {
      await showResult(same)
      return
    }
    const compared = await teamAPI.compare(key, good.value, bad.value)
    good.value = compared.from.number
    bad.value = compared.to.number
    between.value = Math.max(0, compared.submits - 1)
  } catch {
    error.value = t('teamProject.activity.error')
  } finally {
    loading.value = false
  }
}

async function start(): Promise<void> {
  const key = teamStore.key
  if (!key) return
  busy.value = true
  const result = await teamAPI.startBisect(key, good.value, bad.value)
  busy.value = false
  if (!result.success || !result.data) {
    message.error(t('teamProject.dialogs.failed'))
    return
  }
  await showResult(result.data)
}

async function verdict(kind: 'good' | 'bad' | 'skip'): Promise<void> {
  const key = teamStore.key
  const current = bisect.value
  if (!key || !current?.current) return
  busy.value = true
  const result = await teamAPI.bisectVerdict(key, current.id, current.current.number, kind)
  busy.value = false
  if (!result.success || !result.data) {
    // 两个人同时点（wrong-step）：重新取一遍，看到的就是别人点完之后的那一轮
    const fresh = await teamAPI.bisect(key, current.id).catch(() => null)
    if (fresh) await showResult(fresh)
    return
  }
  await showResult(result.data)
}

async function undo(): Promise<void> {
  const key = teamStore.key
  if (!key || !bisect.value) return
  const result = await teamAPI.bisectUndo(key, bisect.value.id)
  if (result.success && result.data) await showResult(result.data)
}

/** 「不找了」：结束，回到对比 */
async function stop(): Promise<void> {
  const key = teamStore.key
  if (!key || !bisect.value) return
  await teamAPI.stopBisect(key, bisect.value.id)
  teamStore.openView('compare', { from: good.value, to: bad.value })
}

onMounted(() => void init())
</script>

<style scoped lang="less">
@import './teamPage.less';

.bisect-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.bisect-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-5);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-bg-surface);
}

.bisect-card > :deep(.submit-card) {
  align-self: stretch;
}

.bisect-line {
  margin: 0;
  color: var(--color-text-secondary);

  &.strong {
    color: var(--color-text-primary);
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
  }
}

.try-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.try-number {
  color: var(--color-text-primary);
  font-size: var(--font-size-3xl);
  font-weight: var(--font-weight-bold);
  font-family: var(--font-family-numeric);
}

.muted {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.command-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);

  code {
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-xs);
    background: var(--color-bg-sunken);
    color: var(--color-text-secondary);
    font-family: var(--font-family-mono);
    font-size: var(--font-size-xs);
    word-break: break-all;
  }
}

.verdict-row {
  display: flex;
  gap: var(--space-2);
}

.bisect-foot {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
}

.link-btn {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-accent-text);
  font-size: var(--font-size-sm);
  cursor: pointer;
}
</style>
