<script setup lang="ts">
/**
 * 团队：每个模型在团队模式里的档案 —— 入职体检结论和履历。
 *
 * 和制作人招人时看的简历是同一份账（`main/agent-v3/core/team/modelDossier.ts`），
 * 这里只是摊给人看。只列事实，不打分：难的活干砸了不等于模型差，怎么看由人判断。
 */
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { ModelCheckup, ModelDossier } from '@core/shared/agentTeam'
import { agentV3API } from '@renderer/api/agentV3'
import { message } from '@renderer/utils/messageManager'
import { describeProbeFailure } from './AIProviders/probeCopy'

const { t } = useI18n()

const models = ref<ModelDossier[] | null>(null)
const expanded = ref(new Set<string>())
const checking = ref(new Set<string>())

const keyOf = (m: ModelDossier): string => JSON.stringify([m.providerId, m.modelId])

async function load(): Promise<void> {
  models.value = await agentV3API.teamModels().catch(() => [])
}

onMounted(load)

function toggle(m: ModelDossier): void {
  const key = keyOf(m)
  const next = new Set(expanded.value)
  if (!next.delete(key)) next.add(key)
  expanded.value = next
}

async function recheck(m: ModelDossier): Promise<void> {
  const key = keyOf(m)
  checking.value = new Set(checking.value).add(key)
  const result = await agentV3API
    .teamModelCheckup({ providerId: m.providerId, modelId: m.modelId })
    .catch(() => null)
  const rest = new Set(checking.value)
  rest.delete(key)
  checking.value = rest
  if (!result?.success || !result.checkup) {
    message.error(t('profile.team.recheckFailed'))
    return
  }
  m.checkup = result.checkup
}

function passed(c: ModelCheckup): boolean {
  return c.reachable && c.tools === 'ok'
}

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 1) return t('assistant.teamBoard.ago.justNow')
  if (minutes < 60) return t('assistant.teamBoard.ago.minutes', { n: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 48) return t('assistant.teamBoard.ago.hours', { n: hours })
  return t('assistant.teamBoard.ago.days', { n: Math.round(hours / 24) })
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return t('profile.team.underMinute')
  if (minutes < 60) return t('profile.team.minutes', { n: minutes })
  return t('profile.team.hours', { n: Math.round(minutes / 6) / 10 })
}

/** 体检明细一行：连通、工具调用、识图（只有声称能看图的才测）、什么时候测的 */
function checkupFacts(c: ModelCheckup): string[] {
  if (!c.reachable) {
    return [t('profile.team.reachFail', { reason: describeProbeFailure(c.failure) })]
  }
  return [
    t('profile.team.reachOk'),
    t(c.tools === 'ok' ? 'profile.team.toolsOk' : 'profile.team.toolsFail'),
    ...(c.vision
      ? [t(c.vision === 'ok' ? 'profile.team.visionOk' : 'profile.team.visionFail')]
      : [])
  ]
}
</script>

<template>
  <div class="settings-content">
    <p v-if="models && models.length === 0" class="empty">{{ $t('profile.team.empty') }}</p>

    <section v-else-if="models" class="settings-section">
      <div class="dossier">
        <div class="row head">
          <span>{{ $t('profile.team.col.model') }}</span>
          <span>{{ $t('profile.team.col.checkup') }}</span>
          <span class="num">{{ $t('profile.team.col.tasks') }}</span>
          <span class="num">{{ $t('profile.team.col.reopened') }}</span>
          <span class="num">{{ $t('profile.team.col.unfinished') }}</span>
          <span class="num">{{ $t('profile.team.col.lastUsed') }}</span>
        </div>

        <template v-for="m in models" :key="keyOf(m)">
          <button
            type="button"
            class="row item"
            :class="{ removed: m.removed }"
            :aria-expanded="expanded.has(keyOf(m))"
            @click="toggle(m)"
          >
            <span class="name">
              <span class="chevron" :class="{ open: expanded.has(keyOf(m)) }">›</span>
              <span class="label">{{ m.name }}</span>
              <span v-if="m.removed" class="tag muted">{{ $t('profile.team.removed') }}</span>
              <span v-else-if="m.providerName" class="provider">{{ m.providerName }}</span>
            </span>
            <span>
              <span v-if="m.removed || !m.checkup" class="tag muted">
                {{ m.removed ? '—' : $t('profile.team.notChecked') }}
              </span>
              <span v-else-if="passed(m.checkup)" class="tag ok">{{
                $t('profile.team.passed')
              }}</span>
              <span v-else class="tag bad">{{ $t('profile.team.failed') }}</span>
            </span>
            <span class="num">{{ m.tasks }}</span>
            <span class="num">{{ m.tasks ? m.reopened : '—' }}</span>
            <span class="num">{{ m.tasks ? m.unfinished : '—' }}</span>
            <span class="num muted-text">{{ m.lastUsedAt ? ago(m.lastUsedAt) : '—' }}</span>
          </button>

          <div v-if="expanded.has(keyOf(m))" class="detail">
            <p v-if="m.removed" class="line">{{ $t('profile.team.removedHint') }}</p>
            <p v-else class="line">
              <template v-if="m.checkup">
                {{
                  [
                    ...checkupFacts(m.checkup),
                    $t('profile.team.checkedAt', { when: ago(m.checkup.at) })
                  ].join(' · ')
                }}
              </template>
              <template v-else>{{ $t('profile.team.notCheckedHint') }}</template>
              <button
                type="button"
                class="link"
                :disabled="checking.has(keyOf(m))"
                @click="recheck(m)"
              >
                {{
                  checking.has(keyOf(m)) ? $t('profile.team.checking') : $t('profile.team.recheck')
                }}
              </button>
            </p>

            <table v-if="m.roles.length" class="roles">
              <thead>
                <tr>
                  <th>{{ $t('profile.team.col.role') }}</th>
                  <th>{{ $t('profile.team.col.tasks') }}</th>
                  <th>{{ $t('profile.team.col.reopened') }}</th>
                  <th>{{ $t('profile.team.col.unfinished') }}</th>
                  <th>{{ $t('profile.team.col.avgTime') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in m.roles" :key="r.roleType ?? ''">
                  <td>{{ r.roleType ?? $t('profile.team.uncategorized') }}</td>
                  <td>{{ r.tasks }}</td>
                  <td>{{ r.reopened }}</td>
                  <td>{{ r.unfinished }}</td>
                  <td>{{ r.avgMs != null ? duration(r.avgMs) : '—' }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="line muted-text">{{ $t('profile.team.noTasks') }}</p>
          </div>
        </template>
      </div>
      <p class="section-note">{{ $t('profile.team.note') }}</p>
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
  gap: var(--space-3);
}

.empty,
.section-note {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.6;
}

.dossier {
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  overflow: hidden;
}

.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 76px 48px 48px 56px 80px;
  gap: var(--space-2);
  align-items: center;
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-bottom: 1px solid var(--color-border-subtle);
  background: none;
  font: inherit;
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
  text-align: left;
}

.head {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.item {
  cursor: pointer;

  &:hover {
    background: var(--color-bg-surface-hover);
  }

  &.removed {
    color: var(--color-text-muted);
  }
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chevron {
  flex-shrink: 0;
  width: 10px;
  color: var(--color-text-muted);
  transition: transform 0.15s ease;

  &.open {
    transform: rotate(90deg);
  }
}

.provider,
.muted-text {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.tag {
  display: inline-block;
  padding: 1px var(--space-2);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  white-space: nowrap;

  &.ok {
    background: var(--color-success-bg);
    color: var(--color-success-text);
  }

  &.bad {
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
  }

  &.muted {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-muted);
  }
}

.detail {
  padding: var(--space-2) var(--space-3) var(--space-3) calc(var(--space-3) + 18px);
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.line {
  margin: 0;
  line-height: 1.6;
}

.link {
  margin-left: var(--space-2);
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: var(--color-accent-text);
  cursor: pointer;

  &:disabled {
    color: var(--color-text-muted);
    cursor: default;
  }
}

.roles {
  width: 100%;
  margin-top: var(--space-2);
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;

  th,
  td {
    padding: 3px 0;
    font-weight: normal;
    text-align: right;
  }

  th:first-child,
  td:first-child {
    text-align: left;
  }

  th {
    color: var(--color-text-muted);
  }
}
</style>
