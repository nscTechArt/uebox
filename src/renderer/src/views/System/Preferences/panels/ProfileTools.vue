<script setup lang="ts">
/**
 * 工具：这个助手手里有哪些工具，以及它们怎么送到模型面前。
 *
 * ## 为什么单独一页
 *
 * 「工具搜索（Beta）」原先挂在「AI 助手 → 实验功能」下，孤零零一个开关，
 * 说明文字里写着「随技能按需加载工具」—— 而用户没有任何地方看得到那些工具
 * 到底是哪些。开关和它管的那份清单分在两页（甚至一页都没有），
 * 用户看不出是同一套东西，和「技能」页当初的毛病一模一样。
 *
 * ## 一个开关，两种含义
 *
 * 这一页的每个开关**按当前模式变含义**，不是两排开关：
 *
 * - 全量模式（默认）：开 = 这个工具进模型的清单，关 = 完全不给。
 * - 工具搜索模式：开 = **常驻**，关 = 改成按需搜索加载 —— 不是不可用。
 *
 * 两份状态分开存（`agentDisabledTools` / `agentResidentTools`），互不影响。
 * 一个人在全量模式下关掉整摊 PCG，切到搜索模式不该发现 PCG 连搜都搜不到：
 * 那是他没点过的第二件事。
 *
 * ## 为什么是「大类折叠 + 小类精确」
 *
 * 一百多个工具平铺出来没人读得完，但按大类一刀切又管不住「PCG 我只要读的那几个」。
 * 所以大类默认折叠、开关统一控制整组，展开之后每一条还能单独点。
 * 大类开关半开时点一下是**全开**：这个开关最常见的用途是「把这一摊全给它」，
 * 而误点全关的代价（模型突然不会做这类事，用户不知道为什么）大得多。
 *
 * ## 哪些没列出来
 *
 * `load_skill` / `read_skill_resource` / `search_tools` / `ask_user` / `task`
 * 不在清单里。它们是这套机制本身：加载入口被关掉就没人能再加载任何工具，
 * 反问通道被关掉模型卡住时只能瞎猜。给了开关，失败的样子是「助手整个不动了，
 * 而设置页上看不出为什么」。
 *
 * ## 不可撤销的那批列出来，但关不掉
 *
 * 全量模式下它们的开关是灰的、锁在打开位置，理由见 `lockedOn()`。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCaretRight, PhMagnifyingGlass } from '@phosphor-icons/vue'

import AppSwitch from '@renderer/components/AppSwitch.vue'
import { agentV3API } from '@renderer/api/agentV3'
import { appSettingsAPI } from '@renderer/api/appSettings'
import { message } from '@renderer/utils/messageManager'
import {
  categoryToggleState,
  groupToolsByCategory,
  nextCategoryValue
} from '@core/shared/toolCategories'
import { toolSummary } from '@core/shared/toolSummary'

const { t } = useI18n()

// ── 工具搜索开关 ────────────────────────────────────────────────────────

const toolSearchEnabled = ref(false)
/** 读回来之前所有开关都禁用：拿猜测值去覆盖用户已存的配置是最糟的一种失败 */
const prefsLoaded = ref(false)
const toolSearchSaving = ref(false)

async function setToolSearchEnabled(enabled: boolean): Promise<void> {
  toolSearchSaving.value = true
  try {
    await appSettingsAPI.setToolSearchEnabled(enabled)
    toolSearchEnabled.value = enabled
  } catch (error) {
    console.error('Failed to save tool search setting:', error)
    message.error(t('profile.tools.toolSearchSaveFailed'))
  } finally {
    toolSearchSaving.value = false
  }
}

// ── 清单 ────────────────────────────────────────────────────────────────

const tools = ref<AgentV3ToolSummary[]>([])
const loading = ref(true)
/**
 * 读失败要说读失败。
 *
 * 静默兜成空数组的话，用户看到的是「你一个工具都没有」，而真相是这次没读着 ——
 * 一个 0 和一句「读取失败」在用户那里是完全不同的两件事。
 */
const loadError = ref('')

const disabledTools = ref(new Set<string>())
const residentTools = ref<Record<string, boolean>>({})
/**
 * 正在落盘的那一条 / 那一组。空串 = 没有在写。
 *
 * **落盘期间整张清单都禁用**，不是只锁住点中的那一个。
 *
 * 只锁一个会丢改动：每次落盘写的是**整份名单**，而名单是在函数开头从当前状态
 * 算出来的。用户关掉 X、不等写完又去关 Y，第二次算名单时 X 那一笔还没提交 ——
 * 算出来的是 `['Y']`，覆盖掉 `['X']`。结果 X 的开关自己弹回打开，用户的第一次
 * 点击无声消失。写的是本机一个 JSON 文件，锁住的这几毫秒用户根本看不见。
 */
const savingKey = ref('')

const query = ref('')
const expanded = ref(new Set<string>())

const visibleTools = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return tools.value
  return tools.value.filter(
    (tool) =>
      tool.name.toLowerCase().includes(keyword) ||
      tool.description.toLowerCase().includes(keyword) ||
      tool.namespace.toLowerCase().includes(keyword)
  )
})

const groups = computed(() => groupToolsByCategory(visibleTools.value))

/**
 * 这一条关不掉：开关画成灰的，锁在打开位置。
 *
 * **只有不可撤销的工具，且只在全量模式。**
 *
 * 为什么恰恰是最危险的那批不给关：拦它们的从来不是这份清单，是每一步的审批
 * 弹窗。从清单里拿走只换来两件事 —— 助手做不了正事（「把这个删掉」它只能
 * 回一句做不到），以及一个假的安全感：真要删东西，Python 和 shell 一样删得掉，
 * 而那两条路不在这一页的管辖范围里（同 `accessScope.ts` 的道理）。
 *
 * 工具搜索模式下不锁：那边关掉不等于不可用，只是改成按需加载，
 * 没有「把能力拿走」这回事，也就没什么要拦的。
 */
function lockedOn(tool: AgentV3ToolSummary): boolean {
  return !toolSearchEnabled.value && tool.risk === 'destructive'
}

/** 整组都关不掉时，大类那个开关也跟着锁住 —— 否则点了没反应 */
function lockedCategory(group: { tools: AgentV3ToolSummary[] }): boolean {
  return group.tools.every(lockedOn)
}

/** 这个工具此刻是不是「开着」。开着的含义随模式变，见文件头 */
function isOn(tool: AgentV3ToolSummary): boolean {
  // 锁住的一律算开着，不看名单：手改过的配置里可能还留着它，
  // 那种情况下界面说「开着」而实际关着，比什么都糟
  if (lockedOn(tool)) return true
  return toolSearchEnabled.value
    ? (residentTools.value[tool.name] ?? tool.defaultResident)
    : !disabledTools.value.has(tool.name)
}

function categoryState(group: { tools: AgentV3ToolSummary[] }): 'all' | 'none' | 'some' {
  return categoryToggleState(group.tools, isOn)
}

function onCount(group: { tools: AgentV3ToolSummary[] }): number {
  return group.tools.filter(isOn).length
}

function categoryLabel(id: string): string {
  return t(`profile.tools.category.${id}`)
}

/**
 * 此刻每次对话要为工具付多少。
 *
 * 前缀是**每一轮、不管用不用得上都要全额付**的东西，而一份工具定义里最贵的
 * 往往不是说明而是参数表 —— 用户在这一页关掉什么，只有看到这个数才知道换来了多少。
 *
 * 工具搜索模式下算的是**常驻的那些**：其余的要用到才加载，不进每一轮的前缀。
 * 数字偏保守（见主进程的 `tokens` 注释），宁可显得贵一点。
 */
const enabledCost = computed(() => {
  const on = tools.value.filter(isOn)
  return { count: on.length, tokens: on.reduce((sum, tool) => sum + tool.tokens, 0) }
})

/** 1200 → 1.2k。四位数的精确值在这儿没有意义，还更难一眼读出量级 */
function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
}

function toggleExpanded(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

/*
 * 搜到东西就把命中的大类展开。
 *
 * 不展开的话，用户搜一个工具名，看到的是一行「蓝图与材质 1」然后什么也没有 ——
 * 他会以为搜坏了。清空搜索框则收回原样，不留下一片被搜索撑开的界面。
 */
watch(query, (keyword) => {
  expanded.value = keyword.trim() ? new Set(groups.value.map((group) => group.id)) : new Set()
})

/**
 * 落盘之后再改界面，不做乐观更新。
 *
 * 这些开关决定的是下一轮模型手里有什么，写失败了却显示成功，
 * 用户会以为自己已经关掉了 —— 而它照常在跑。
 */
async function applyToggle(names: string[], on: boolean, key: string): Promise<void> {
  // 同步挡住第二次点击。模板那边的 `disabled` 要等下一帧才生效，
  // 而丢改动只需要两次点击落在同一帧里（见 `savingKey` 的说明）
  if (savingKey.value) return
  // 关不掉的那几个不进名单 —— 大类开关一次关掉整组时，它们要被挑出来留下
  const byName = new Map(tools.value.map((tool) => [tool.name, tool]))
  const writable = names.filter((name) => {
    const tool = byName.get(name)
    return !tool || !lockedOn(tool)
  })
  if (writable.length === 0) return
  savingKey.value = key
  try {
    if (toolSearchEnabled.value) {
      const next = { ...residentTools.value }
      for (const name of writable) {
        const tool = tools.value.find((entry) => entry.name === name)
        // 和内置默认一致就把这条差量删掉：以后调整内置常驻清单，
        // 没有特意改过的用户会自动跟上
        if (tool && tool.defaultResident === on) delete next[name]
        else next[name] = on
      }
      await appSettingsAPI.setResidentTools(next)
      residentTools.value = next
    } else {
      const next = new Set(disabledTools.value)
      for (const name of writable) {
        if (on) next.delete(name)
        else next.add(name)
      }
      await appSettingsAPI.setDisabledTools([...next])
      disabledTools.value = next
    }
  } catch (error) {
    console.error('保存工具开关失败:', error)
    message.error(t('profile.tools.saveFailed'))
  } finally {
    savingKey.value = ''
  }
}

function toggleTool(tool: AgentV3ToolSummary, on: boolean): void {
  void applyToggle([tool.name], on, tool.name)
}

function toggleCategory(group: { id: string; tools: AgentV3ToolSummary[] }): void {
  const on = nextCategoryValue(categoryState(group))
  void applyToggle(
    group.tools.map((tool) => tool.name),
    on,
    group.id
  )
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    const [catalog, prefs] = await Promise.all([
      agentV3API.listTools(),
      appSettingsAPI.getToolPreferences()
    ])
    tools.value = catalog.tools
    toolSearchEnabled.value = prefs.toolSearchEnabled
    disabledTools.value = new Set(prefs.disabledTools)
    residentTools.value = prefs.residentTools
    prefsLoaded.value = true
    loadError.value = ''
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
    message.error(t('profile.tools.loadFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <div class="settings-content">
    <!-- 工具搜索：这一页所有开关的含义都由它决定，所以放在清单前面 -->
    <section class="settings-section">
      <h4 class="section-title">{{ $t('profile.tools.toolSearchTitle') }}</h4>
      <div class="setting-item">
        <div class="setting-info">
          <div class="setting-label">{{ $t('profile.tools.toolSearchBeta') }}</div>
          <div class="setting-desc">
            {{
              $t(toolSearchEnabled ? 'profile.tools.toolSearchOn' : 'profile.tools.toolSearchOff')
            }}
            {{ $t('profile.tools.toolSearchHint') }}
          </div>
        </div>
        <AppSwitch
          :checked="toolSearchEnabled"
          :disabled="!prefsLoaded || toolSearchSaving"
          :aria-label="$t('profile.tools.toolSearchBeta')"
          @update:checked="setToolSearchEnabled"
        />
      </div>
    </section>

    <!-- 清单 -->
    <section class="settings-section">
      <div class="section-head">
        <h4 class="section-title">
          {{ $t('profile.tools.listTitle') }}
          <span class="count">{{ loadError ? '—' : tools.length }}</span>
        </h4>
      </div>
      <!-- 一句话。这一页原来在这儿堆了三段（开关含义、哪些没列出来、为什么有灰的），
           用户看到的是一屏说明书 —— 而他来这一页只想找某个工具的开关。
           剩下那两件事改成**用到时才说**：灰开关的理由挂在徽章的 title 上。
           带上数字：关掉东西换来了多少，不给数就只能凭感觉 -->
      <p v-if="!loading && !loadError" class="section-note">
        {{
          $t(toolSearchEnabled ? 'profile.tools.listNoteSearch' : 'profile.tools.listNoteFull', {
            on: enabledCost.count,
            total: tools.length,
            tokens: formatTokens(enabledCost.tokens)
          })
        }}
      </p>

      <a-input
        v-model:value="query"
        class="search"
        allow-clear
        :placeholder="$t('profile.tools.searchPlaceholder')"
      >
        <template #prefix><PhMagnifyingGlass /></template>
      </a-input>

      <p v-if="loading" class="section-note">{{ $t('profile.tools.loading') }}</p>
      <p v-else-if="loadError" class="section-note entity-error">
        {{ $t('profile.tools.loadFailedDetail', { reason: loadError }) }}
      </p>
      <p v-else-if="tools.length === 0" class="section-note">{{ $t('profile.tools.empty') }}</p>
      <p v-else-if="groups.length === 0" class="section-note">{{ $t('profile.tools.noMatch') }}</p>
      <ul v-else class="category-list">
        <li v-for="group in groups" :key="group.id" class="category">
          <div class="category-head">
            <!-- 展开是个真按钮，开关是另一个：点标题只折叠，不会顺手改掉一整组 -->
            <button
              class="category-open"
              :aria-expanded="expanded.has(group.id)"
              @click="toggleExpanded(group.id)"
            >
              <PhCaretRight class="caret" :class="{ open: expanded.has(group.id) }" />
              <span class="category-name">{{ categoryLabel(group.id) }}</span>
              <span class="category-count">{{ onCount(group) }} / {{ group.tools.length }}</span>
            </button>
            <AppSwitch
              class="category-switch"
              :class="{ locked: lockedCategory(group) }"
              :checked="categoryState(group) === 'all'"
              :indeterminate="categoryState(group) === 'some'"
              :disabled="!prefsLoaded || !!savingKey || lockedCategory(group)"
              :aria-label="
                $t('profile.tools.categoryToggleLabel', {
                  name: categoryLabel(group.id),
                  on: onCount(group),
                  total: group.tools.length
                })
              "
              @update:checked="toggleCategory(group)"
            />
          </div>

          <ul v-if="expanded.has(group.id)" class="tool-list">
            <li
              v-for="tool in group.tools"
              :key="tool.name"
              class="tool-item"
              :class="{ off: !isOn(tool) }"
            >
              <div class="tool-info">
                <div class="tool-name">
                  {{ tool.name }}
                  <!-- 只标例外。「会改动」几乎每个工具都有，标出来等于没标，
                       却让每一行都多一块色斑 —— 值得占位置的只有不可撤销 -->
                  <span
                    v-if="tool.risk === 'destructive'"
                    class="badge badge-destructive"
                    :title="lockedOn(tool) ? $t('profile.tools.lockedHint') : undefined"
                  >
                    {{ $t('profile.tools.risk.destructive') }}
                  </span>
                </div>
                <!-- 一句话。原文是写给模型看的几百字，铺在这儿既看不全也没人读 -->
                <div class="tool-desc">{{ toolSummary(tool.description) }}</div>
              </div>
              <AppSwitch
                size="small"
                :class="{ locked: lockedOn(tool) }"
                :checked="isOn(tool)"
                :disabled="!prefsLoaded || !!savingKey || lockedOn(tool)"
                :aria-label="
                  lockedOn(tool)
                    ? $t('profile.tools.lockedToggleLabel', { name: tool.name })
                    : $t('profile.tools.toggleLabel', { name: tool.name })
                "
                @update:checked="(value: boolean) => toggleTool(tool, value)"
              />
            </li>
          </ul>
        </li>
      </ul>
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

.setting-label {
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.setting-desc,
.section-note {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.6;
}

.category-list,
.tool-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.category {
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
}

.category-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3);
}

.category-open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
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

.caret {
  flex-shrink: 0;
  color: var(--color-text-muted);
  transition: transform var(--motion-fast) var(--easing-standard);

  &.open {
    transform: rotate(90deg);
  }
}

.category-name {
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.category-count {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}

.tool-list {
  padding: 0 var(--space-3) var(--space-3) var(--space-8);
}

.tool-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-2) 0;
  border-top: 1px solid var(--color-border-subtle);

  /* 关掉的压暗，但不压到看不清 —— 它还得能被找到再打开 */
  &.off .tool-name,
  &.off .tool-desc {
    opacity: 0.5;
  }
}

.tool-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tool-name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-family-mono);
  font-size: var(--font-size-xs);
  color: var(--color-text-primary);
}

/* 一行封顶。工具名底下这句只回答「这玩意儿是干嘛的」，
   多一行都会把一屏能看到的工具数砍掉一半 */
.tool-desc {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 锁住的开关要一眼看出来是点不动的。
   只压这几个，不去改 AppSwitch 的 `:disabled` —— 落盘那几毫秒整张清单都是
   disabled 的，那样改会让每次点击都闪一下灰 */
.app-switch.locked {
  opacity: 0.45;
  cursor: not-allowed;
}

.badge {
  padding: 0 6px;
  border-radius: 10px;
  background: var(--color-bg-surface-hover);
  font-size: 10px;
  font-family: var(--font-family-base);
  color: var(--color-text-muted);
}

.badge-destructive {
  background: var(--color-danger-bg);
  color: var(--color-danger-text);
}

.search {
  width: 100%;
}

.entity-error {
  color: var(--color-danger-text);
}
</style>
