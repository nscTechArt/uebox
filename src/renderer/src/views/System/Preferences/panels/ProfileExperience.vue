<script setup lang="ts">
import AppSegmented from '@renderer/components/AppSegmented.vue'
/**
 * 「经验库」设置页：做事时踩过又绕过去的坑（见 main/agent-v3/experience/）。
 *
 * ## 为什么单独一页
 *
 * 起初放在技能页里当一个分组，后来拆出来（2026-10-01 用户定）：技能是一份
 * 「它会做什么」的说明书，经验是「它在哪儿翻过车」的记录，放在一页里两样都挤。
 * 不放工程详情里，是因为经验分两层，通用那层不属于任何一个工程。
 *
 * 开关没有另起一个：仍是技能页的「自动记住做法」，它同时管技能和经验。
 * 这一页只在关着时说一句，不再摆一份同样的开关 —— 两处都能拨，就得想清楚
 * 两处谁说了算。
 *
 * ## 为什么每条没有开关
 *
 * 技能有开关，是因为它每轮都进清单、占 token，用户可能想暂时不给。经验只在报错
 * 对得上时才出现，不占常驻位置；不想要就删，不管用的会被自动淘汰。再加一个开关，
 * 是多一个用户要理解的状态，换不来什么。
 *
 * ## 默认看见什么
 *
 * 一行：标题、做法、层级和状态两个标记、适用版本和「照着做几次、成了几次」。
 * 触发条件、对照组比较、来源这些在详情里；已淘汰的勾选了才列。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCaretRight, PhPushPin } from '@phosphor-icons/vue'

import AppButton from '@renderer/components/AppButton.vue'
import AppCheckbox from '@renderer/components/AppCheckbox.vue'
import AppModal from '@renderer/components/AppModal.vue'
import { agentV3API } from '@renderer/api/agentV3'
import { useAIConfigStore } from '@renderer/store/modules/aiConfig'
import { message } from '@renderer/utils/messageManager'
import { confirmDialog } from '@renderer/utils/dialog'

import {
  activeCount,
  experienceProjects,
  filterExperiences,
  liftPercents,
  refOf,
  type ExperienceScope
} from './experienceFilter'

const { t } = useI18n()
const aiConfigStore = useAIConfigStore()

const SCOPES: readonly ExperienceScope[] = ['all', 'global', 'project']

const entries = ref<AgentV3Experience[]>([])
const lastCuration = ref<AgentV3CurationSummary>()
const loading = ref(true)
/** 读失败要说读失败，不能显示成「还没有经验」 */
const loadError = ref('')

const scope = ref<ExperienceScope>('all')
const projectPath = ref<string>()
const showRetired = ref(false)

const learningOff = computed(() => aiConfigStore.skillLearningMode === 'off')
const projects = computed(() => experienceProjects(entries.value))
const visible = computed(() =>
  filterExperiences(entries.value, {
    scope: scope.value,
    ...(projectPath.value ? { projectPath: projectPath.value } : {}),
    showRetired: showRetired.value
  })
)

function scopeCount(option: ExperienceScope): number {
  const active = entries.value.filter((e) => e.status !== 'retired')
  if (option === 'all') return active.length
  return active.filter((e) => e.layer === option).length
}

function onScopeChange(next: ExperienceScope): void {
  scope.value = next
  // 进「工程」那一档时默认选第一个有经验的工程；下拉只在这一档出现
  if (next === 'project' && !projects.value.some((p) => p.path === projectPath.value)) {
    projectPath.value = projects.value[0]?.path
  }
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const result = await agentV3API.listExperiences()
    entries.value = result.entries
    lastCuration.value = result.lastCuration
    loadError.value = ''
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

function layerLabel(entry: AgentV3Experience): string {
  return entry.layer === 'global' ? t('profile.experience.layerGlobal') : (entry.projectName ?? '')
}

function effectLine(entry: AgentV3Experience): string {
  const parts: string[] = []
  const engines = entry.engines?.length
    ? entry.engines
    : entry.verified?.engine
      ? [entry.verified.engine]
      : []
  if (engines.length) parts.push(`UE ${engines.join(' · ')}`)
  if (entry.stats.adopted > 0) {
    parts.push(
      t('profile.experience.effect', {
        adopted: entry.stats.adopted,
        ok: entry.stats.adoptedOk
      })
    )
  }
  return parts.join(' · ')
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── 详情 ────────────────────────────────────────────────────────────────

const detail = ref<AgentV3Experience>()
const detailOpen = ref(false)
const pinning = ref(false)

function openDetail(entry: AgentV3Experience): void {
  detail.value = entry
  detailOpen.value = true
}

const detailLift = computed(() => (detail.value ? liftPercents(detail.value.stats) : undefined))

async function togglePin(pinned: boolean): Promise<void> {
  const entry = detail.value
  if (!entry) return
  pinning.value = true
  try {
    await agentV3API.setExperiencePinned(refOf(entry), pinned)
    await refresh()
    detail.value = entries.value.find((e) => e.id === entry.id) ?? entry
  } catch (error) {
    message.error(t('profile.experience.actionFailed', { reason: reasonOf(error) }))
  } finally {
    pinning.value = false
  }
}

function deleteDetail(): void {
  const entry = detail.value
  if (!entry) return
  confirmDialog({
    title: t('profile.experience.deleteTitle'),
    content: t('profile.experience.deleteContent'),
    okText: t('common.delete'),
    cancelText: t('common.cancel'),
    danger: true,
    onOk: async () => {
      try {
        await agentV3API.deleteExperience(refOf(entry))
        detailOpen.value = false
        await refresh()
        message.success(t('profile.experience.deleted'))
      } catch (error) {
        message.error(t('profile.experience.actionFailed', { reason: reasonOf(error) }))
      }
    }
  })
}

// ── 撤销上次整理 ────────────────────────────────────────────────────────

function undoCuration(): void {
  const last = lastCuration.value
  if (!last) return
  confirmDialog({
    title: t('profile.experience.undoTitle'),
    // 先说清楚那次改了什么，再让人决定 —— 撤销会把整理之后的统计一起退回去
    content: t('profile.experience.undoContent', {
      at: new Date(last.at).toLocaleString(),
      added: last.added,
      retired: last.retired
    }),
    okText: t('profile.experience.undo'),
    cancelText: t('common.cancel'),
    onOk: async () => {
      try {
        await agentV3API.undoLastCuration()
        await refresh()
        message.success(t('profile.experience.undone'))
      } catch (error) {
        message.error(t('profile.experience.undoFailed', { reason: reasonOf(error) }))
      }
    }
  })
}

onMounted(refresh)
</script>

<template>
  <section class="settings-section">
    <div class="section-head">
      <!-- 页名和说明在页头（index.vue 的 pageHeaders），这里只是清单的小标题 -->
      <h4 class="section-title">
        {{ $t('profile.experience.listTitle') }}
        <span class="count">{{ loadError ? '—' : activeCount(entries) }}</span>
      </h4>
      <AppButton v-if="lastCuration" variant="soft" size="medium" @click="undoCuration">
        {{ $t('profile.experience.undo') }}
      </AppButton>
    </div>
    <p v-if="learningOff" class="section-note off-note">{{ $t('profile.experience.offNote') }}</p>

    <div class="filters">
      <!-- @vue-generic {typeof SCOPES[number]} -->
      <AppSegmented
        :model-value="scope"
        :options="SCOPES"
        :aria-label="$t('profile.experience.title')"
        @update:model-value="onScopeChange"
      >
        <template #default="{ option }">
          {{ $t(`profile.experience.filter.${option}`) }}
          <span class="tab-count">{{ scopeCount(option) }}</span>
        </template>
      </AppSegmented>
      <a-select
        v-if="scope === 'project' && projects.length > 0"
        v-model:value="projectPath"
        class="project-select"
        :options="projects.map((p) => ({ value: p.path, label: p.name }))"
      />
      <AppCheckbox v-model:checked="showRetired" class="retired-toggle">
        {{ $t('profile.experience.showRetired') }}
      </AppCheckbox>
    </div>

    <p v-if="loading" class="section-note">{{ $t('profile.skills.loading') }}</p>
    <p v-else-if="loadError" class="section-note entity-error">
      {{ $t('profile.experience.loadFailed', { reason: loadError }) }}
    </p>
    <p v-else-if="visible.length === 0" class="section-note">
      {{
        scope === 'project' ? $t('profile.experience.emptyProject') : $t('profile.experience.empty')
      }}
    </p>
    <ul v-else class="entity-list">
      <li
        v-for="entry in visible"
        :key="`${entry.layer}:${entry.projectPath ?? ''}:${entry.id}`"
        class="entity-item"
        :class="{ off: entry.status === 'retired' || learningOff }"
      >
        <button class="entity-open" @click="openDetail(entry)">
          <div class="entity-name">
            {{ entry.title }}
            <span class="badge" :class="{ 'badge-global': entry.layer === 'global' }">
              {{ layerLabel(entry) }}
            </span>
            <span class="badge" :class="{ 'badge-proven': entry.status === 'proven' }">
              {{ $t(`profile.experience.status.${entry.status}`) }}
            </span>
            <span v-if="entry.pinned" class="badge">
              <PhPushPin :size="10" /> {{ $t('profile.experience.pinnedBadge') }}
            </span>
          </div>
          <div class="entity-desc">{{ entry.advice }}</div>
          <div v-if="effectLine(entry)" class="entity-meta">{{ effectLine(entry) }}</div>
        </button>
        <PhCaretRight class="caret" :size="14" />
      </li>
    </ul>

    <AppModal v-model:open="detailOpen" :title="detail?.title ?? ''" :width="620" destroy-on-close>
      <dl v-if="detail" class="detail-grid">
        <dt>{{ $t('profile.experience.detail.how') }}</dt>
        <dd>{{ detail.advice }}</dd>

        <dt>{{ $t('profile.experience.detail.when') }}</dt>
        <dd>
          <code>{{ detail.tool }}</code>
          <span>
            {{ $t('profile.experience.detail.whenValue', { pattern: detail.errorPattern }) }}
          </span>
        </dd>

        <dt>{{ $t('profile.experience.detail.scope') }}</dt>
        <dd>
          {{
            detail.layer === 'global'
              ? $t('profile.experience.detail.scopeGlobal')
              : $t('profile.experience.detail.scopeProject', { name: detail.projectName })
          }}
        </dd>

        <template v-if="detail.engines?.length || detail.notFor?.length || detail.verified?.engine">
          <dt>{{ $t('profile.experience.detail.engines') }}</dt>
          <dd>
            <span v-if="detail.engines?.length || detail.verified?.engine">
              {{
                $t('profile.experience.detail.enginesOk', {
                  versions: (detail.engines?.length
                    ? detail.engines
                    : [detail.verified?.engine]
                  ).join('、')
                })
              }}
            </span>
            <span v-if="detail.notFor?.length">
              {{
                $t('profile.experience.detail.enginesNo', {
                  versions: detail.notFor.join('、')
                })
              }}
            </span>
          </dd>
        </template>

        <dt>{{ $t('profile.experience.detail.effect') }}</dt>
        <dd>
          {{
            $t('profile.experience.detail.effectValue', {
              shown: detail.stats.shown,
              adopted: detail.stats.adopted,
              ok: detail.stats.adoptedOk
            })
          }}
          <div class="muted">
            {{
              detailLift
                ? $t('profile.experience.detail.lift', {
                    without: detailLift.without,
                    with: detailLift.with
                  })
                : $t('profile.experience.detail.liftUnknown')
            }}
          </div>
        </dd>

        <template v-if="detail.source">
          <dt>{{ $t('profile.experience.detail.source') }}</dt>
          <dd>{{ detail.source }}</dd>
        </template>
      </dl>

      <template #footer>
        <div class="detail-footer">
          <AppButton danger @click="deleteDetail">{{ $t('common.delete') }}</AppButton>
          <AppCheckbox
            :checked="!!detail?.pinned"
            :disabled="pinning || detail?.status === 'retired'"
            @update:checked="togglePin"
          >
            {{ $t('profile.experience.detail.pin') }}
          </AppCheckbox>
        </div>
      </template>
    </AppModal>
  </section>
</template>

<style scoped lang="less">
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

.count {
  margin-left: var(--space-2);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.section-note {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.6;
}

.filters {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.project-select {
  min-width: 160px;
}

.retired-toggle {
  margin-left: auto;
  font-size: var(--font-size-xs);
}

.tab-count {
  font-variant-numeric: tabular-nums;
  opacity: 0.6;
}

.entity-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.entity-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
  transition: border-color 0.15s ease;

  &:hover {
    border-color: var(--color-border);
  }

  &.off .entity-name,
  &.off .entity-desc,
  &.off .entity-meta {
    opacity: 0.5;
  }
}

.entity-open {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
    border-radius: var(--radius-sm);
  }
}

.entity-name {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px;
  border-radius: 10px;
  background: var(--color-bg-surface-hover);
  font-size: 10px;
  color: var(--color-text-muted);
}

.badge-global {
  background: var(--color-accent-bg);
  color: var(--color-accent-text);
}

.badge-proven {
  background: var(--color-success-bg);
  color: var(--color-success-text);
}

.entity-desc {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.6;
}

.entity-meta {
  font-size: 10px;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.off-note {
  color: var(--color-warning-text);
}

.entity-error {
  color: var(--color-danger-text);
}

.caret {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.detail-grid {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  gap: var(--space-3) var(--space-4);
  margin: 0;
  font-size: var(--font-size-xs);
  line-height: 1.6;

  dt {
    color: var(--color-text-muted);
  }

  dd {
    margin: 0;
    color: var(--color-text-primary);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  code {
    font-family: var(--font-family-mono);
    padding: 0 4px;
    border-radius: var(--radius-sm);
    background: var(--color-bg-surface-hover);
  }
}

.muted {
  color: var(--color-text-muted);
}

.detail-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  width: 100%;
}
</style>
