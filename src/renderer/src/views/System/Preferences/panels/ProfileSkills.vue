<script setup lang="ts">
import AppSegmented from '@renderer/components/AppSegmented.vue'
/**
 * 技能：这个助手会做哪些事，以及它自己学会的那些。
 *
 * ## 为什么是一页，而不是三段
 *
 * 上一版这里叫「扩展」，一页塞了插件、MCP、技能三样，理由是「回答它现在有
 * 哪些能力」。那个定位是错的：一页的职责一旦是「把所有东西展示出来」，
 * 它就必然重复其他每一页 —— MCP 段只是把 MCP 设置页读一遍再放个链接，
 * 技能段只能看不能删（删在「个性化」），插件段永远显示 0。
 *
 * 现在这一页只回答一个问题：**技能**。列全、能搜、能按来源筛、点开能看能改、
 * 每条能单独关掉。「自动沉淀」开关也在这儿 —— 它管的正是这张单子往里加什么，
 * 把开关和它填充的清单分在两页，用户看不出是同一套东西。
 *
 * ## 为什么没有「批量删除」
 *
 * 有过一个「删掉我的 N 条」主按钮，撤了。主按钮的作用是**引导**，
 * 而我们没有任何理由引导用户删自己的技能。删除是一个人想好了才做的动作，
 * 该在那一条的详情里，不该摆在页头等人误点。
 *
 * ## 为什么内置的也列出来、也能改
 *
 * 二十多个内置技能以前只在输入框敲 `/` 时瞥得见一眼，「这东西到底会干什么」
 * 没有地方回答。改内置的那份不是原地改，是在用户目录里另存一份覆盖它
 * （发现路径用户优先），所以随包更新不会把用户的修改冲掉，删掉副本就退回内置版。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhMagnifyingGlass } from '@phosphor-icons/vue'

import AppButton from '@renderer/components/AppButton.vue'
import AppModal from '@renderer/components/AppModal.vue'
import AppSwitch from '@renderer/components/AppSwitch.vue'
import { agentV3API } from '@renderer/api/agentV3'
import { useAIConfigStore } from '@renderer/store/modules/aiConfig'
import { message } from '@renderer/utils/messageManager'
import { confirmDialog } from '@renderer/utils/dialog'
import { SKILL_CREATOR_NAME } from '@core/shared/skillLearning'

import {
  countSkillsBySource,
  filterSkills,
  type SkillEntry,
  type SkillSourceFilter
} from './skillFilter'

const { t } = useI18n()
const aiConfigStore = useAIConfigStore()

// ── 自动沉淀 ────────────────────────────────────────────────────────────

const LEARNING_OPTIONS: readonly AgentV3SkillLearning[] = ['off', 'ask', 'auto']

const learningMode = computed({
  get: () => aiConfigStore.skillLearningMode,
  set: (value: AgentV3SkillLearning) => aiConfigStore.setSkillLearningMode(value)
})

const learningHint = computed(() =>
  t(
    {
      off: 'profile.skills.learningOffHint',
      ask: 'profile.skills.learningAskHint',
      auto: 'profile.skills.learningAutoHint'
    }[learningMode.value]
  )
)

function learningLabel(mode: AgentV3SkillLearning): string {
  return t(
    {
      off: 'profile.skills.learningOff',
      ask: 'profile.skills.learningAsk',
      auto: 'profile.skills.learningAuto'
    }[mode]
  )
}

/**
 * 这条技能此刻是不是「开关开着、但模型其实看不见」。
 *
 * 关档时 `applySkillLearningMode` 会把 `ue-skill-creator` 从清单里真的删掉，
 * 而它的开关仍然显示开着 —— 用户看到的和模型拿到的对不上，正是开关最不该
 * 出现的失效方向。这里不去动开关本身（开关记的是另一件事，改它等于让用户
 * 点了没反应），只把这一行标出来。
 */
function mutedByLearningOff(skill: SkillEntry): boolean {
  return learningMode.value === 'off' && skill.name === SKILL_CREATOR_NAME
}

// ── 清单 ────────────────────────────────────────────────────────────────

/** 筛选档的排列顺序。「全部」在最前，其余按「删不掉 → 能删」排 */
const SOURCE_FILTERS: readonly SkillSourceFilter[] = ['all', 'builtin', 'plugin', 'user']

const skills = ref<SkillEntry[]>([])
const loading = ref(true)
/**
 * 读失败要说读失败。
 *
 * 静默兜成空数组的话，用户看到的是「你一个技能都没有」，而真相是这次没读着。
 * 一个 0 和一句「读取失败」在用户那里是完全不同的两件事。
 */
const loadError = ref('')
/** 正在切开关的那条。整页禁用太重，只锁住那一行 */
const togglingName = ref('')

const query = ref('')
const sourceFilter = ref<SkillSourceFilter>('all')

const countBySource = computed(() => countSkillsBySource(skills.value))

const visibleSkills = computed(() =>
  filterSkills(skills.value, { query: query.value, source: sourceFilter.value })
)

/** 筛选档的条数。写在标签上，用户不用逐个点开才知道哪档有东西 */
function filterCount(filter: SkillSourceFilter): number {
  return filter === 'all' ? skills.value.length : countBySource.value[filter]
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    skills.value = (await agentV3API.listSkills()).skills
    loadError.value = ''
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

/**
 * 关掉 / 打开一条。
 *
 * 先落盘再刷新，不做乐观更新：这个开关决定的是下一轮模型看不看得见这条技能，
 * 写失败了却显示成功，用户会以为自己已经关掉了。
 */
async function toggleSkill(skill: SkillEntry, enabled: boolean): Promise<void> {
  togglingName.value = skill.name
  try {
    await agentV3API.setSkillDisabled(skill.name, !enabled)
    await refresh()
  } catch (error) {
    console.error('切换技能开关失败:', error)
    message.error(t('profile.skills.toggleFailed'))
  } finally {
    togglingName.value = ''
  }
}

function openSkillsFolder(): void {
  void window.api.invoke('shell:openSkillsDir')
}

// ── 详情弹窗 ────────────────────────────────────────────────────────────

const detailOpen = ref(false)
const detailName = ref('')
const detailSource = ref<SkillEntry['source']>('builtin')
/** `copy` = 内置或插件带的，保存会在用户目录里另存一份覆盖它 */
const detailSavesAs = ref<'own' | 'copy'>('own')
const detailContent = ref('')
/** 盘上那份。用来判断改过没有 —— 没改过就不给保存，免得用户以为自己漏保存了 */
const detailSavedContent = ref('')
const detailLoading = ref(false)
const detailError = ref('')
const detailSaving = ref(false)

const detailDirty = computed(() => detailContent.value !== detailSavedContent.value)
/** 只有用户自己那份能删。内置和插件带的删了下次启动又回来，给了按钮就是骗人 */
const detailDeletable = computed(() => detailSource.value === 'user')

async function openDetail(skill: SkillEntry): Promise<void> {
  detailOpen.value = true
  detailName.value = skill.name
  detailSource.value = skill.source
  detailContent.value = ''
  detailSavedContent.value = ''
  detailError.value = ''
  detailLoading.value = true

  try {
    const document = await agentV3API.readSkill(skill.name)
    if (!document) {
      detailError.value = t('profile.skills.detailMissing')
      return
    }
    detailSource.value = document.source
    detailSavesAs.value = document.savesAs
    detailContent.value = document.content
    detailSavedContent.value = document.content
  } catch (error) {
    detailError.value = error instanceof Error ? error.message : String(error)
  } finally {
    detailLoading.value = false
  }
}

/**
 * 保存。
 *
 * 失败**不关弹窗**：错误多半是 frontmatter 写坏了（主进程会挡下来，
 * 因为存下去那条技能会从清单上无声消失），用户需要就地把它改回来。
 * 关掉弹窗等于把他刚写的东西一起丢了。
 */
async function saveDetail(): Promise<void> {
  detailSaving.value = true
  try {
    await agentV3API.writeSkill(detailName.value, detailContent.value)
    detailSavedContent.value = detailContent.value
    await refresh()
    // 改内置的那份实际上是另存了一个覆盖件，说清楚它现在归谁
    message.success(
      t(detailSavesAs.value === 'copy' ? 'profile.skills.savedAsCopy' : 'profile.skills.saved')
    )
    detailSavesAs.value = 'own'
    detailSource.value = 'user'
  } catch (error) {
    message.error(
      t('profile.skills.saveFailed', {
        reason: error instanceof Error ? error.message : String(error)
      })
    )
  } finally {
    detailSaving.value = false
  }
}

/**
 * 删掉这一条。
 *
 * 删完要分两种情况说话：如果这条只是内置版的覆盖件，删掉之后内置那份会自动
 * 顶上来 —— 用户看到技能还在清单里，不告诉他的话会以为没删掉。
 */
function deleteDetail(): void {
  const name = detailName.value
  confirmDialog({
    title: t('profile.skills.deleteTitle', { name }),
    content: t('profile.skills.deleteContent'),
    okText: t('common.delete'),
    cancelText: t('common.cancel'),
    danger: true,
    onOk: async () => {
      await agentV3API.deleteSkills([name])
      await refresh()
      detailOpen.value = false
      const restored = skills.value.some((skill) => skill.name === name)
      message.success(
        t(restored ? 'profile.skills.deletedRestored' : 'profile.skills.deletedGone', { name })
      )
    }
  })
}

function closeDetail(): void {
  detailOpen.value = false
}

onMounted(refresh)
</script>

<template>
  <div class="settings-content">
    <!-- 自动沉淀 -->
    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.skills.learningTitle') }}</h4>
      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-desc">{{ $t('profile.skills.learningDesc') }}</div>
          <div class="setting-desc">{{ learningHint }}</div>
        </div>
        <!-- @vue-generic {typeof LEARNING_OPTIONS[number]} -->
        <AppSegmented
          v-model="learningMode"
          :options="LEARNING_OPTIONS"
          :aria-label="$t('profile.skills.learningTitle')"
        >
          <template #default="{ option }">
            {{ learningLabel(option) }}
          </template>
        </AppSegmented>
      </div>
    </section>

    <!-- 清单 -->
    <section class="settings-section">
      <div class="section-head">
        <h4 class="section-title">
          {{ $t('profile.skills.listTitle') }}
          <span class="count">{{ loadError ? '—' : skills.length }}</span>
        </h4>
        <AppButton variant="soft" size="medium" @click="openSkillsFolder">
          {{ $t('profile.skills.openFolder') }}
        </AppButton>
      </div>
      <p class="section-note">{{ $t('profile.skills.listNote') }}</p>

      <div class="filters">
        <a-input
          v-model:value="query"
          class="search"
          allow-clear
          :placeholder="$t('profile.skills.searchPlaceholder')"
        >
          <template #prefix><PhMagnifyingGlass /></template>
        </a-input>
        <!-- @vue-generic {typeof SOURCE_FILTERS[number]} -->
        <AppSegmented
          v-model="sourceFilter"
          :options="SOURCE_FILTERS"
          :aria-label="$t('profile.skills.listTitle')"
        >
          <template #default="{ option }">
            {{ $t(`profile.skills.filter.${option}`) }}
            <span class="tab-count">{{ filterCount(option) }}</span>
          </template>
        </AppSegmented>
      </div>

      <p v-if="loading" class="section-note">{{ $t('profile.skills.loading') }}</p>
      <p v-else-if="loadError" class="section-note entity-error">
        {{ $t('profile.skills.loadFailed', { reason: loadError }) }}
      </p>
      <p v-else-if="skills.length === 0" class="section-note">{{ $t('profile.skills.empty') }}</p>
      <p v-else-if="visibleSkills.length === 0" class="section-note">
        {{ $t('profile.skills.noMatch') }}
      </p>
      <ul v-else class="entity-list">
        <li
          v-for="skill in visibleSkills"
          :key="skill.name"
          class="entity-item"
          :class="{ off: !skill.enabled || mutedByLearningOff(skill) }"
        >
          <!-- 整块是个真按钮：点开详情。用 button 而不是给 li 挂 click，
               键盘和读屏才认得出这是能点的 -->
          <button class="entity-open" @click="openDetail(skill)">
            <div class="entity-name">
              {{ skill.name }}
              <span class="badge">{{ $t(`profile.skills.source.${skill.source}`) }}</span>
              <span v-if="!skill.enabled" class="badge badge-off">
                {{ $t('profile.skills.offBadge') }}
              </span>
              <span v-else-if="mutedByLearningOff(skill)" class="badge badge-off">
                {{ $t('profile.skills.learningOffBadge') }}
              </span>
            </div>
            <div class="entity-desc">{{ skill.description }}</div>
          </button>
          <AppSwitch
            :checked="skill.enabled"
            :disabled="togglingName === skill.name"
            :aria-label="$t('profile.skills.toggleLabel', { name: skill.name })"
            @update:checked="(value: boolean) => toggleSkill(skill, value)"
          />
        </li>
      </ul>
    </section>

    <!-- 详情：看正文、改正文、删这一条 -->
    <!-- 不能加 hide-footer：那会把 <footer> 整个删掉，连同下面这个 footer 插槽 -->
    <AppModal v-model:open="detailOpen" :title="detailName" :width="760" destroy-on-close>
      <p v-if="detailLoading" class="section-note">{{ $t('profile.skills.detailLoading') }}</p>
      <p v-else-if="detailError" class="section-note entity-error">{{ detailError }}</p>
      <template v-else>
        <p class="section-note">
          {{
            detailSavesAs === 'copy'
              ? $t('profile.skills.overrideNote')
              : $t('profile.skills.ownNote')
          }}
        </p>
        <a-textarea v-model:value="detailContent" class="editor" :rows="18" spellcheck="false" />
      </template>

      <template #footer>
        <div class="detail-footer">
          <!-- 删除在左下角，和「保存」隔开。它是这个弹窗里唯一不可逆的动作 -->
          <AppButton v-if="detailDeletable" danger @click="deleteDetail">
            {{ $t('common.delete') }}
          </AppButton>
          <span v-else />
          <div class="detail-actions">
            <AppButton @click="closeDetail">{{ $t('common.close') }}</AppButton>
            <AppButton
              variant="primary"
              :disabled="!detailDirty || detailLoading || !!detailError"
              :loading="detailSaving"
              @click="saveDetail"
            >
              {{ $t('common.save') }}
            </AppButton>
          </div>
        </div>
      </template>
    </AppModal>
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

.count {
  margin-left: var(--space-2);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.setting-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.setting-desc,
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
}

.search {
  flex: 1;
  min-width: 0;
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

  /* 关掉的压暗，但不压到看不清 —— 它还得能被找到再打开 */
  &.off .entity-name,
  &.off .entity-desc {
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
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.badge {
  padding: 0 6px;
  border-radius: 10px;
  background: var(--color-bg-surface-hover);
  font-size: 10px;
  color: var(--color-text-muted);
}

.badge-off {
  background: var(--color-warning-bg);
  color: var(--color-warning-text);
}

.entity-desc {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.6;
}

.entity-error {
  color: var(--color-danger-text);
}

/* 等宽：这是一份 Markdown 文件，缩进和 frontmatter 的对齐要看得出来 */
.editor {
  margin-top: var(--space-3);
  font-family: var(--font-family-mono);
  font-size: var(--font-size-xs);
  line-height: 1.7;
}

.detail-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  width: 100%;
}

.detail-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
</style>
