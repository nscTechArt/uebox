<script setup lang="ts">
import AppSegmented from '@renderer/components/AppSegmented.vue'
/**
 * 用量统计。
 *
 * 数据全部从**已经存在的对话记录**里算（见 `usageStats.ts`），不新开埋点、
 * 不落第二份账、一个字节都不出这台机器。
 *
 * 柱状图是手写的 div，没有引图表库：这一页只有一张单系列柱图和几张排行榜，
 * 为它拖进来一个几百 KB 的依赖不划算（AGENTS.md 硬规则 7）。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useChatMessagesStore } from '@renderer/store/modules/chatMessages'
import type { ChatMessage } from '@renderer/store/modules/chatMessages'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'

import {
  average,
  buildHeatmap,
  buildUsageReport,
  cacheHitRate,
  formatCount,
  formatDuration,
  formatPercent,
  HEATMAP_DAYS,
  metricValue,
  rangeDays,
  uncachedOf,
  USAGE_METRICS,
  USAGE_RANGES,
  type UsageDay,
  type UsageMetric,
  type UsageRange,
  type UsageReport
} from './usageStats'

const chatMsgStore = useChatMessagesStore()
const chatSessionsStore = useChatSessionsStore()
const { locale, t } = useI18n()

const range = ref<UsageRange>('week')
/** 当前档位实际覆盖几天；全量档由现存记录的最早日期决定 */
const windowDays = ref(7)

/**
 * 柱子和方格画什么。
 *
 * 只画 token 的话，「哪天干活最多」和「哪天最费」被强行当成同一个问题 ——
 * 而一天里全是长上下文的追问，和一天里真的改了三十处资产，是两件不同的事。
 * 柱状图和热力图共用这一个开关：它们问的是同一个问题，只是窗口长短不同。
 */
const metric = ref<UsageMetric>('uncached')

/** 排行榜只列前十。再多就不是「用得最多的是什么」而是一张全量清单了 */
const TOP_N = 10

const report = ref<UsageReport | null>(null)
/** 热力图那一年的日汇总。和上面同一个函数算出来的，不会有两份对不上的数字 */
const yearDays = ref<UsageDay[]>([])

/** 会话 id → 工程名。没绑工程的会话不进这张表，统计层会把它们归到「没绑工程」 */
function projectBySid(): Record<string, string> {
  const table: Record<string, string> = {}
  for (const session of chatSessionsStore.sessions) {
    const name = session.project?.projectName?.trim()
    if (name) table[session.id] = name
  }
  return table
}

function refresh(): void {
  const snapshot = chatMsgStore.exportChatMessagesPersistence()
  const messages = (snapshot.messagesBySid ?? {}) as Record<string, ChatMessage[]>
  const now = Date.now()
  const projects = projectBySid()

  report.value = buildUsageReport(messages, {
    days: rangeDays(range.value),
    now,
    projectBySid: projects
  })
  windowDays.value = report.value.days.length
  // 热力图的窗口和上面那排档位无关，所以单算一遍。宁可多走一趟内存里的
  // 消息，也不要为它再开一条统计路径 —— 两份数字对不上的时候用户信哪一份
  yearDays.value = buildUsageReport(messages, { days: HEATMAP_DAYS, now }).days
}

function selectRange(next: UsageRange): void {
  range.value = next
  refresh()
}

/**
 * 「今日」不画按天图。
 *
 * 一根占满整个卡片的柱子回答不了任何问题 —— 它永远是 100%，因为窗口里只有它。
 */
const showDailyChart = computed(() => windowDays.value > 1)

/** 天数一多，3px 的缝就把柱子挤没了；全量记录较长时缝要收到 1px */
const barGap = computed(() => (windowDays.value > 60 ? '1px' : '3px'))

function metricOf(day: UsageDay): number {
  return metricValue(day, metric.value)
}

/**
 * 某一天的浮窗。柱状图和热力图共用一个 —— 两边各写一份，改的时候一定会漏一边。
 *
 * 缓存命中单独列出来而不是并进 token 数：不写的话，一个「今天 3 千 token」的
 * 提示会让人以为这天几乎没干活，而实际上另外还读了 30 万缓存。
 */
function dayTooltip(day: UsageDay): string {
  return t('profile.usage.barTooltip', {
    date: day.date,
    tokens: formatCount(uncachedOf(day)),
    cached: formatCount(day.cacheRead),
    turns: formatCount(day.turns),
    changes: formatCount(day.changes)
  })
}

/** 柱高按窗口内最大值归一。全是 0 时统一给一条贴底的线，不让它变成除零 */
const maxMetric = computed(() => Math.max(1, ...(report.value?.days ?? []).map(metricOf)))

function barHeight(day: UsageDay): string {
  const value = metricOf(day)
  if (value <= 0) return '2px'
  return `${Math.max(2, Math.round((value / maxMetric.value) * 100))}%`
}

/** 只在两端和中间标日期，30 天档下每根都标会糊成一片 */
function axisLabel(index: number): string {
  const days = report.value?.days ?? []
  if (days.length === 0) return ''
  const shown = index === 0 || index === days.length - 1 || index === Math.floor(days.length / 2)
  if (!shown) return ''
  // `YYYY-MM-DD` → `MM-DD`，年份在这张图上没有信息量
  return days[index].date.slice(5)
}

const totals = computed(() => report.value?.totals ?? null)

/**
 * 不含缓存命中的 token 总数。
 *
 * 总览的主角是它而不是四项之和：缓存命中经常占到九成以上，而单价低一个数量级，
 * 把它们加成一个数写在最显眼的位置，等于告诉用户「你烧了一千万」，而账单上
 * 对应的其实是一百万那一档。
 */
const uncachedTokens = computed(() => (totals.value ? uncachedOf(totals.value) : 0))

/** 平均每轮烧掉多少。它比总数更能解释「为什么这么贵」—— 一轮里模型往返很多次 */
const tokensPerTurn = computed(() =>
  totals.value ? average(uncachedTokens.value, totals.value.turns) : null
)

const toolsPerTurn = computed(() =>
  totals.value ? average(totals.value.toolCalls, totals.value.turns) : null
)

const hitRate = computed(() => (totals.value ? cacheHitRate(totals.value) : null))

/** 构成里每一项占多少。分母是四项之和，也就是总 token */
function shareOf(value: number): number {
  const total = totals.value?.tokens ?? 0
  return total > 0 ? value / total : 0
}

const breakdown = computed(() => {
  const t = totals.value
  if (!t) return []
  return [
    { key: 'input', value: t.input },
    { key: 'output', value: t.output },
    { key: 'cacheRead', value: t.cacheRead },
    { key: 'cacheWrite', value: t.cacheWrite }
  ]
})

const topTools = computed(() => (report.value?.tools ?? []).slice(0, TOP_N))
const topSkills = computed(() => (report.value?.skills ?? []).slice(0, TOP_N))
const topChangeTools = computed(() => (report.value?.changes.byTool ?? []).slice(0, TOP_N))
/**
 * 按工程分组只在**分得开**的时候才有意义。
 *
 * 一条工程都没绑过的用户，这一段只会是孤零零一行「没绑工程」—— 那不是分组，
 * 是把总览又抄了一遍。
 */
const projects = computed(() => {
  const rows = report.value?.projects ?? []
  if (rows.length === 1 && rows[0].name === '') return []
  return rows
})

/** 这段时间里一处都没动过。整段收起来，别给一堆 0 */
const hasChanges = computed(() => {
  const changes = report.value?.changes
  return Boolean(changes && (changes.total > 0 || changes.failed > 0))
})

/** 平均每轮替用户落地几处。它把「AI 干了多少活」和上面的轮次接上 */
const changesPerTurn = computed(() => {
  const t = totals.value
  return t && report.value ? average(report.value.changes.total, t.turns) : null
})

function failRate(tool: { calls: number; failed: number }): string {
  if (tool.calls <= 0 || tool.failed <= 0) return ''
  return formatPercent(tool.failed / tool.calls)
}

const heatmap = computed(() => buildHeatmap(yearDays.value, metric.value))

/** 一年里真的跑过活的天数。热力图上一眼数不出来，但它是这张图最直白的一句话 */
const activeDays = computed(
  () => yearDays.value.filter((day) => day.tokens > 0 || day.turns > 0 || day.changes > 0).length
)

/** 月份用系统的短名，中英各自对：`locale` 本来就是 `zh-CN` / `en-US` 这种合法标签 */
function monthLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Intl.DateTimeFormat(locale.value, { month: 'short' }).format(
    new Date(year, month - 1, day)
  )
}

onMounted(refresh)
</script>

<template>
  <div class="settings-content">
    <section class="settings-section">
      <div class="section-head">
        <h4 class="section-title">{{ $t('profile.usage.overviewTitle') }}</h4>
        <!-- @vue-generic {typeof USAGE_RANGES[number]} -->
        <AppSegmented
          :model-value="range"
          :options="USAGE_RANGES"
          :aria-label="$t('profile.usage.overviewTitle')"
          @update:model-value="selectRange"
        >
          <template #default="{ option: item }">
            {{ $t(`profile.usage.range.${item}`) }}
          </template>
        </AppSegmented>
      </div>

      <!--
        总览：两排八张卡。

        原来是四张，副标题里再塞一句、下面再吊两句话 —— 结果每张卡的副标题都被
        省略号截断（「命中率 96.8%，单价通常低一个…」），而被截掉的正是那句解释。
        一张卡塞两件事，等于两件都说不清。摊成八张，每张只答一个数。

        **故意不摆四项之和**：新输入、输出、缓存读取三者的单价差着一个数量级，
        加成一个数只会让人以为自己烧掉了十倍的钱。所以「共计」那张卡算的是
        不含缓存命中的那部分 —— 它才是按全价计费的东西。
      -->
      <div v-if="report" class="totals">
        <div class="total-card">
          <div class="total-label">{{ $t('profile.usage.totalTurns') }}</div>
          <div class="total-value">{{ formatCount(report.totals.turns) }}</div>
          <div class="total-hint">{{ $t('profile.usage.totalTurnsHint') }}</div>
        </div>
        <div class="total-card">
          <div class="total-label">{{ $t('profile.usage.toolCallsTotal') }}</div>
          <div class="total-value">{{ formatCount(report.totals.toolCalls) }}</div>
          <div class="total-hint">
            {{
              toolsPerTurn === null
                ? '—'
                : $t('profile.usage.toolsPerTurn', { count: toolsPerTurn.toFixed(1) })
            }}
          </div>
        </div>
        <div class="total-card">
          <div class="total-label">{{ $t('profile.usage.uncachedTotal') }}</div>
          <div class="total-value">{{ formatCount(uncachedTokens) }}</div>
          <div class="total-hint">{{ $t('profile.usage.uncachedTotalHint') }}</div>
        </div>
        <div class="total-card">
          <div class="total-label">{{ $t('profile.usage.perTurn') }}</div>
          <div class="total-value">
            {{ tokensPerTurn === null ? '—' : formatCount(tokensPerTurn) }}
          </div>
          <div class="total-hint">{{ $t('profile.usage.perTurnHint') }}</div>
        </div>
        <div class="total-card">
          <div class="total-label">{{ $t('profile.usage.input') }}</div>
          <div class="total-value">{{ formatCount(report.totals.input) }}</div>
          <div class="total-hint">{{ $t('profile.usage.inputHint') }}</div>
        </div>
        <div class="total-card">
          <div class="total-label">{{ $t('profile.usage.output') }}</div>
          <div class="total-value">{{ formatCount(report.totals.output) }}</div>
          <div class="total-hint">{{ $t('profile.usage.outputHint') }}</div>
        </div>
        <div class="total-card">
          <div class="total-label">{{ $t('profile.usage.cacheRead') }}</div>
          <div class="total-value">{{ formatCount(report.totals.cacheRead) }}</div>
          <div class="total-hint">{{ $t('profile.usage.cacheReadHint') }}</div>
        </div>
        <div class="total-card">
          <div class="total-label">{{ $t('profile.usage.cacheHitRate') }}</div>
          <div class="total-value">{{ formatPercent(hitRate) }}</div>
          <div class="total-hint">{{ $t('profile.usage.cacheHitRateHint') }}</div>
        </div>
      </div>
    </section>

    <!-- 按天。「今日」只有一天，画出来是一根占满卡片的柱子，没有信息 -->
    <section v-if="showDailyChart" class="settings-section">
      <div class="section-head">
        <h4 class="section-title">{{ $t('profile.usage.chartTitle') }}</h4>
        <!-- @vue-generic {typeof USAGE_METRICS[number]} -->
        <AppSegmented
          v-model="metric"
          :options="USAGE_METRICS"
          :aria-label="$t('profile.usage.chartTitle')"
        >
          <template #default="{ option: item }">
            {{ $t(`profile.usage.metric.${item}`) }}
          </template>
        </AppSegmented>
      </div>

      <div v-if="report" class="chart">
        <div class="bars" :style="{ gap: barGap }">
          <div
            v-for="(day, index) in report.days"
            :key="day.date"
            class="bar-slot"
            :title="dayTooltip(day)"
          >
            <div class="bar" :style="{ height: barHeight(day) }" />
            <span class="bar-label">{{ axisLabel(index) }}</span>
          </div>
        </div>
      </div>
      <p v-if="metric === 'uncached'" class="section-note">
        {{ $t('profile.usage.uncachedMetricNote') }}
      </p>
    </section>

    <!-- 一年热力图：柱状图只看得见最近一个月，长期节奏得靠它 -->
    <section v-if="heatmap.weeks.length > 0" class="settings-section">
      <h4 class="section-title">{{ $t('profile.usage.heatmapTitle') }}</h4>
      <div class="chart" :style="{ '--weeks': heatmap.weeks.length }">
        <div class="heatmap-months">
          <span
            v-for="month in heatmap.months"
            :key="month.date"
            class="heatmap-month"
            :style="{ gridColumn: month.column + 1 }"
          >
            {{ monthLabel(month.date) }}
          </span>
        </div>
        <div class="heatmap">
          <div v-for="(week, index) in heatmap.weeks" :key="index" class="heatmap-week">
            <div
              v-for="(cell, row) in week"
              :key="row"
              class="heat-cell"
              :class="[`level-${cell.level}`, { blank: !cell.day }]"
              :title="cell.day ? dayTooltip(cell.day) : ''"
            />
          </div>
        </div>
        <div class="heatmap-legend">
          <span>{{ $t('profile.usage.heatmapActive', { count: activeDays }) }}</span>
          <span class="legend-scale">
            <span>{{ $t('profile.usage.heatmapLess') }}</span>
            <span
              v-for="level in [0, 1, 2, 3, 4]"
              :key="level"
              class="heat-cell legend-cell"
              :class="`level-${level}`"
            />
            <span>{{ $t('profile.usage.heatmapMore') }}</span>
          </span>
        </div>
      </div>
      <p class="section-note">{{ $t('profile.usage.heatmapNote') }}</p>
    </section>

    <!-- 明细：输入/输出/缓存 -->
    <section v-if="report" class="settings-section">
      <h4 class="section-title">{{ $t('profile.usage.breakdownTitle') }}</h4>
      <ul class="breakdown">
        <li v-for="row in breakdown" :key="row.key">
          <span class="rank-name">{{ $t(`profile.usage.${row.key}`) }}</span>
          <span class="share-track">
            <span class="share-fill" :style="{ width: `${shareOf(row.value) * 100}%` }" />
          </span>
          <span class="rank-count">{{ formatCount(row.value) }}</span>
          <span class="rank-share">{{ formatPercent(shareOf(row.value)) }}</span>
        </li>
      </ul>
      <p class="section-note">
        {{ $t('profile.usage.breakdownNote', { total: formatCount(report.totals.tokens) }) }}
      </p>
    </section>

    <!--
      AI 替你干了多少活。

      这里只放「干成了什么」。失败数落在下面那句脚注里，不做成卡片：一个光秃秃的
      总失败数用户拿它没法做任何事，可行动的版本是「工具活动」里按工具分的失败率。
    -->
    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.usage.changesTitle') }}</h4>
      <p v-if="!hasChanges" class="section-note">{{ $t('profile.usage.changesEmpty') }}</p>
      <template v-else-if="report">
        <div class="totals totals-three">
          <div class="total-card">
            <div class="total-label">{{ $t('profile.usage.changesApplied') }}</div>
            <div class="total-value">{{ formatCount(report.changes.total) }}</div>
            <div class="total-hint">{{ $t('profile.usage.changesAppliedHint') }}</div>
          </div>
          <div class="total-card">
            <div class="total-label">{{ $t('profile.usage.changesTargets') }}</div>
            <div class="total-value">{{ formatCount(report.changes.targets) }}</div>
            <div class="total-hint">{{ $t('profile.usage.changesTargetsHint') }}</div>
          </div>
          <div class="total-card">
            <div class="total-label">{{ $t('profile.usage.changesPerTurn') }}</div>
            <div class="total-value">
              {{ changesPerTurn === null ? '—' : changesPerTurn.toFixed(1) }}
            </div>
            <div class="total-hint">{{ $t('profile.usage.changesPerTurnHint') }}</div>
          </div>
        </div>

        <ul v-if="topChangeTools.length > 0" class="ranking">
          <li v-for="entry in topChangeTools" :key="entry.name">
            <span class="rank-name">{{ entry.name }}</span>
            <span class="rank-count">{{ formatCount(entry.count) }}</span>
          </li>
        </ul>
        <p class="section-note">{{ $t('profile.usage.changesNote') }}</p>
        <p v-if="report.changes.failed > 0" class="section-note">
          {{ $t('profile.usage.changesFailedNote', { count: report.changes.failed }) }}
        </p>
      </template>
    </section>

    <!-- 工具活动 -->
    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.usage.toolsTitle') }}</h4>
      <p v-if="topTools.length === 0" class="section-note">{{ $t('profile.usage.empty') }}</p>
      <template v-else>
        <div class="table">
          <div class="table-head">
            <span>{{ $t('profile.usage.colTool') }}</span>
            <span>{{ $t('profile.usage.colCalls') }}</span>
            <span>{{ $t('profile.usage.colFailed') }}</span>
            <span>{{ $t('profile.usage.colMedian') }}</span>
          </div>
          <div v-for="tool in topTools" :key="tool.name" class="table-row">
            <span class="rank-name">{{ tool.name }}</span>
            <span class="rank-count">{{ formatCount(tool.calls) }}</span>
            <span class="rank-count" :class="{ danger: tool.failed > 0 }">
              {{ tool.failed > 0 ? `${formatCount(tool.failed)} · ${failRate(tool)}` : '—' }}
            </span>
            <span class="rank-count">{{ formatDuration(tool.medianMs) }}</span>
          </div>
        </div>
        <p class="section-note">{{ $t('profile.usage.toolsNote') }}</p>
      </template>
    </section>

    <!-- 技能使用 -->
    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.usage.skillsTitle') }}</h4>
      <p v-if="topSkills.length === 0" class="section-note">{{ $t('profile.usage.empty') }}</p>
      <ul v-else class="ranking">
        <li v-for="skill in topSkills" :key="skill.name">
          <span class="rank-name">{{ skill.name }}</span>
          <span class="chip">{{ $t(`profile.usage.skillSource.${skill.source}`) }}</span>
          <span class="rank-count">{{ formatCount(skill.count) }}</span>
        </li>
      </ul>
    </section>

    <!-- 按工程 -->
    <section v-if="projects.length > 0" class="settings-section">
      <h4 class="section-title">{{ $t('profile.usage.projectsTitle') }}</h4>
      <div class="table">
        <div class="table-head">
          <span>{{ $t('profile.usage.colProject') }}</span>
          <span>{{ $t('profile.usage.colTurns') }}</span>
          <span>{{ $t('profile.usage.colTokens') }}</span>
          <span>{{ $t('profile.usage.colChanges') }}</span>
        </div>
        <div v-for="project in projects" :key="project.name || '__none__'" class="table-row">
          <span class="rank-name">
            {{ project.name || $t('profile.usage.noProject') }}
          </span>
          <span class="rank-count">{{ formatCount(project.turns) }}</span>
          <!-- 和柱状图同一个口径：这一列换成含缓存的总数，两处就会对不上 -->
          <span class="rank-count">{{ formatCount(uncachedOf(project)) }}</span>
          <span class="rank-count">{{ formatCount(project.changes) }}</span>
        </div>
      </div>
      <p class="section-note">{{ $t('profile.usage.uncachedMetricNote') }}</p>
    </section>
  </div>
</template>

<style scoped lang="less">
.settings-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.section-title {
  margin: 0;
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  letter-spacing: 0.02em;
  flex: 1;
}

.section-note {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.6;
}

.totals {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-3);

  &.totals-three {
    grid-template-columns: repeat(3, 1fr);
  }
}

.total-card {
  padding: var(--space-4);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  min-width: 0;
}

.total-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.total-value {
  margin-top: 2px;
  font-size: var(--font-size-lg);
  color: var(--color-text-primary);
  font-variant-numeric: tabular-nums;
}

/* 副标题折行，不截断。同一排的卡片高度本来就会拉齐，多出来的那一行不额外占地方；
   而截断截掉的恰恰是解释那一句 —— 留一个「单价通常低一个…」比不写更糟 */
.total-hint {
  margin-top: 2px;
  font-size: 10px;
  line-height: 1.5;
  color: var(--color-text-muted);
}

.chart {
  padding: var(--space-4);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
}

.bars {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 140px;
}

.bar-slot {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  height: 100%;
  min-width: 0;
}

.bar {
  width: 100%;
  border-radius: 2px 2px 0 0;
  background: var(--color-accent-solid);
  transition: height 0.2s ease;
}

.bar-label {
  margin-top: var(--space-1);
  height: 14px;
  font-size: 10px;
  color: var(--color-text-muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/*
 * 热力图。列宽用 1fr + aspect-ratio 让格子始终是正方形，不写死像素 ——
 * 设置面板的宽度跟着窗口走，写死的话窄窗口下最后几周会被挤出去看不见。
 * 月份标和方格用同一套 grid 列，才对得齐。
 */
.heatmap-months,
.heatmap {
  display: grid;
  grid-template-columns: repeat(var(--weeks), minmax(0, 1fr));
  gap: 3px;
}

.heatmap-months {
  margin-bottom: var(--space-1);
  height: 12px;
}

.heatmap-month {
  font-size: 10px;
  line-height: 12px;
  color: var(--color-text-muted);
  white-space: nowrap;
  /* 一个月的名字比一列宽，让它往右溢出，不要把列撑开 */
  overflow: visible;
}

.heatmap-week {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.heat-cell {
  width: 100%;
  aspect-ratio: 1;
  border-radius: 2px;
  background: var(--color-accent-solid);

  /* 0 档不是「淡一点的蓝」，是「什么都没有」—— 用中性底，别给灰着色 */
  &.level-0 {
    background: var(--color-bg-surface-hover);
  }

  /*
   * 最浅那档要明显比 0 档亮。两者在 12px 的方格上本来就难分，压得太淡的话
   * 「这天干了一点活」和「这天没开机」看起来是同一格。
   */
  &.level-1 {
    opacity: 0.36;
  }

  &.level-2 {
    opacity: 0.58;
  }

  &.level-3 {
    opacity: 0.78;
  }

  /* 窗口开始之前那几格：连底色都不给，否则看起来像「那天在线但没干活」 */
  &.blank {
    background: transparent;
  }
}

.heatmap-legend {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-3);
  font-size: 10px;
  color: var(--color-text-muted);
}

.legend-scale {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.legend-cell {
  width: 10px;
  flex-shrink: 0;
}

.breakdown,
.ranking {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-xs);
    color: var(--color-text-secondary);

    &:nth-child(odd) {
      background: var(--color-bg-surface);
    }
  }
}

.breakdown li {
  gap: var(--space-3);
}

/* 占比条：四个绝对数并排的时候，「98% 是缓存命中」这件事一眼看不出来 */
.share-track {
  flex: 1;
  min-width: 40px;
  height: 4px;
  border-radius: 2px;
  background: var(--color-bg-surface-hover);
  overflow: hidden;
}

.share-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--color-accent-solid);
}

.table {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.table-head,
.table-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 72px 104px 80px;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.table-head {
  color: var(--color-text-muted);
  font-size: 10px;
  letter-spacing: 0.04em;
  text-transform: uppercase;

  span:not(:first-child) {
    text-align: right;
  }
}

.table-row:nth-child(even) {
  background: var(--color-bg-surface);
}

.rank-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rank-count {
  color: var(--color-text-primary);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
  text-align: right;

  &.danger {
    color: var(--color-danger-text);
  }
}

.rank-share {
  width: 48px;
  text-align: right;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.chip {
  padding: 0 var(--space-2);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  font-size: 10px;
  line-height: 16px;
  flex-shrink: 0;
  margin-left: auto;
}
</style>
