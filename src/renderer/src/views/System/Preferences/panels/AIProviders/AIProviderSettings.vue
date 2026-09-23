<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import CreatorPlanCard from './CreatorPlanCard.vue'
import AppTooltip from '@renderer/components/AppTooltip.vue'
/**
 * 本地直连 Provider 设置 —— 三层披露的第一层。
 *
 * 社区版没有官方 AI 网关，模型一律由用户自己配置的 Provider 直连厂商。
 * 这一页只回答两个问题：**模型从哪儿来**、**哪个模型干哪件事**。
 *
 * 细节按需往里收：
 *   这一页        有哪些来源（卡片）+ 角色绑定
 *   ↓ 点卡片
 *   Provider 弹窗  地址、协议、密钥、模型清单、（折叠）附加请求头
 *   ↓ 点模型
 *   模型弹窗       能力位、（折叠）思考档位、（折叠）上下文与输出上限
 *
 * 这么分是因为**改的频率差着数量级**：角色绑定天天调，Provider 配一次管半年，
 * 单个模型的能力位和档位阶梯绝大多数人一辈子不碰。全平铺在一页上，
 * 那些天天要用的就被埋在一屏控件里了。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@renderer/utils/messageManager'
import {
  findVisionCapableRole,
  MODEL_ROLES,
  type CatalogEntry,
  type ModelRole
} from '@core/shared/aiProvider'
import ProviderCatalogModal from './ProviderCatalogModal.vue'
import ModelManagerModal from './ModelManagerModal.vue'
import {
  filterModelOptionsForRole,
  modelOptionLabel,
  useAiProviders,
  type ModelOption
} from './useAiProviders'

const { t } = useI18n()
const state = useAiProviders()
const { catalog, providers, roles, configured, encryptionAvailable, configPath } = state

const showCatalog = ref(false)
const showManager = ref(false)

/**
 * 首次加载还没回来。
 *
 * settings 为 null 时上面的 computed 全部落到空档：providers 是空列表、
 * configured 是 false、roles 是空对象 —— 于是页面会先把「还没有可用的模型」
 * 「未设置」这些**结论**画出来，等数据一到又全部推翻重画，肉眼看到的就是
 * 空态闪一下才变成真容。这个窗口里用骨架占位，别下结论。
 *
 * 只卡「settings 还没到」这一段：加载失败时 loading 复位、settings 仍为 null，
 * 页面退回普通空态让人能看见出了问题，而不是永远转骨架。
 */
const initialLoading = computed(() => state.loading.value && state.settings.value === null)

/** 角色的展示顺序。chat 在最前，因为只配它一个就能把对话那一面跑起来 */
const ROLES = MODEL_ROLES

/**
 * 说明比一行长的角色，长文收进 `?` 里。
 *
 * 十个角色每个都摊三行说明，这一页就是一整屏文字压着十个小下拉框 ——
 * 而这些字第二次进来之后全是噪音。留在行内的是**选之前要知道的**，
 * 收进去的是**选错了才需要读的**。
 */
const ROLES_WITH_MORE = new Set<ModelRole>([
  'vision',
  'embedding',
  'image',
  'video',
  'model3d',
  'realtime',
  'tts',
  // 「语音识别」要解释的是**空着会怎样**：它不像别的角色那样空着就没了，
  // 而是退回实时语音那一路 —— 那条路对豆包用户是死胡同。一行放不下
  'stt',
  'music',
  // 「判定」是这一列里最需要解释的：名字看不出它是什么，而它又是**唯一一个
  // 不配也完全不影响任何功能**的角色。这两件事都得说，行内放不下
  'judge'
])

/**
 * 不会回落到别的角色的那几个 —— 没配就是真的用不了，而不是「悄悄用对话模型顶上」。
 * 所以它们的「未设置」得说清楚代价，不能只是一个灰字。
 *
 * vision 是有条件的那一个：主模型自己看得懂图时它空着也没事，见 `showMissing`。
 *
 * **`judge` 故意不在这里。** 它同样不回落，但不配不等于用不了 —— 每一处用到
 * 判定的地方都留着原来那条确定性规则，空着只是不启用增强。给它挂一句红字
 * 「XX 不可用」是在撒谎，而且会把用户推去配一个他根本不需要的云端服务。
 */
const ROLES_WITHOUT_FALLBACK = new Set<ModelRole>([
  'vision',
  'embedding',
  'image',
  'video',
  'model3d',
  'realtime',
  'tts',
  'music'
])

onMounted(() => {
  void state.load()
})

// ==================== 服务商 ====================
function openProvider(providerId: string): void {
  state.selectProvider(providerId)
  showManager.value = true
}

/**
 * 「添加 Provider」先走目录弹窗挑一家，挑完再进管理弹窗。
 *
 * 目录是一次性的选择（一屏图标），管理是持续编辑 —— 两件事塞进同一个弹窗
 * 只会让人分不清「我现在是在选还是在改」。
 */
function handlePickCatalog(entry: CatalogEntry): void {
  state.startCreate(entry)
  showManager.value = true
}

function handlePickCustom(): void {
  state.startCreate()
  showManager.value = true
}

/** 管理弹窗里点「+ 添加 Provider」：回到目录挑一家 */
function handleAddFromManager(): void {
  showCatalog.value = true
}

/**
 * 卡片上那行状态。
 *
 * 密钥没配好是**最常见**的故障，而它在列表上完全看不出来 —— 用户只会发现
 * 对话报错，然后一个个点进去找。所以这里直接标出来。
 */
function keyStatus(provider: (typeof providers.value)[number]): {
  text: string
  tone: 'ok' | 'warn' | 'none'
} {
  const key = provider.apiKey
  if (key.kind === 'none') {
    // 「一把都没存」有两种截然相反的含义，光看 kind 分不出来：
    // 本机推理（Ollama / LMStudio）确实不需要，而厂商那边是**漏填了**。
    // 不问目录的话，后者会拿到一张绿卡写着「无需密钥」，然后在调用时 401 ——
    // 而这个函数存在的理由正是「别让密钥问题只能靠报错发现」。
    //
    // 按 id 前缀匹配：撞车时草稿 id 会被改成 openai-image-2，仍是同一家。
    // 用 some 而不是 find，是让判断偏向「要密钥」—— 多提醒一次的代价，
    // 远小于对着一个配错的 Provider 说「没问题」。
    const needsKey = catalog.value.some(
      (entry) => entry.requiresApiKey && provider.id.startsWith(entry.id)
    )
    return needsKey
      ? { text: t('aiProvider.list.keyMissing'), tone: 'warn' }
      : { text: t('aiProvider.list.noKeyNeeded'), tone: 'none' }
  }
  if (key.kind === 'oauth') {
    return key.hasKey
      ? { text: t('aiProvider.list.linked'), tone: 'ok' }
      : { text: t('aiProvider.list.keyMissing'), tone: 'warn' }
  }
  return key.hasKey
    ? { text: t('aiProvider.list.keyReady'), tone: 'ok' }
    : { text: t('aiProvider.list.keyMissing'), tone: 'warn' }
}

// ==================== 角色绑定 ====================
interface RoleModelOption extends ModelOption {
  modelName: string
}

interface RoleModelGroup {
  id: string
  name: string
  options: RoleModelOption[]
}

/** Provider 在菜单里只出现一次，模型名不再被一长串相同前缀挤掉。 */
const modelGroups = computed<RoleModelGroup[]>(() =>
  providers.value.map((provider) => ({
    id: provider.id,
    name: provider.displayName,
    options: provider.models.map((model) => {
      const modelName = model.displayName || model.id
      return {
        value: `${provider.id}::${model.id}`,
        label: modelOptionLabel(provider.displayName, modelName),
        modelName,
        kind: provider.kind,
        supportsVision: model.supportsVision === true
      }
    })
  }))
)

/** 过滤规则连同它的理由都在 useAiProviders.ts 里，那边有测试守着 */
function groupsForRole(role: ModelRole): RoleModelGroup[] {
  return modelGroups.value
    .map((group) => ({ ...group, options: filterModelOptionsForRole(group.options, role) }))
    .filter((group) => group.options.length > 0)
}

function roleSelectionLabel(role: ModelRole): string | null {
  const value = roleValue(role)
  if (!value) return null
  return (
    modelGroups.value.flatMap((group) => group.options).find((option) => option.value === value)
      ?.label ?? null
  )
}

function roleControlLabel(role: ModelRole): string {
  return `${t(`aiProvider.roles.${role}`)}: ${roleSelectionLabel(role) || t('aiProvider.roles.unset')}`
}

/** 悬停或聚焦时把被截断的文字滚到末尾，移开后回到开头。 */
function scrollText(element: HTMLElement | null, toEnd: boolean): void {
  if (!element || element.scrollWidth <= element.clientWidth) return
  element.scrollTo({ left: toEnd ? element.scrollWidth : 0 })
}

function selectedTextElement(event: Event): HTMLElement | null {
  const origin =
    event.currentTarget instanceof Element
      ? event.currentTarget
      : event.target instanceof Element
        ? event.target
        : null
  return (
    origin
      ?.closest<HTMLElement>('.compact-select')
      ?.querySelector<HTMLElement>('.ant-select-selection-item') ?? null
  )
}

function scrollSelectedTextToEnd(event: Event): void {
  scrollText(selectedTextElement(event), true)
}

function resetSelectedText(event: Event): void {
  scrollText(selectedTextElement(event), false)
}

function scrollOptionTextToEnd(event: Event): void {
  scrollText(event.currentTarget instanceof HTMLElement ? event.currentTarget : null, true)
}

function resetOptionText(event: Event): void {
  scrollText(event.currentTarget instanceof HTMLElement ? event.currentTarget : null, false)
}

/**
 * 未绑定时返回 `null` 而**不是 undefined**。
 *
 * ant-design-vue 的 useMergedState 把 `value === undefined` 当成「非受控」，
 * 会退回下拉框自己的内部状态 —— 于是存盘失败时界面照样显示用户刚选的那一项，
 * 直到重开设置页才发现根本没存上。传 null 它就是受控的，存不上会自己弹回未设置。
 */
function roleValue(role: ModelRole): string | null {
  const binding = roles.value[role]
  return binding ? `${binding.providerId}::${binding.modelId}` : null
}

/**
 * 「没配就真的用不了」的提示，只对不回落的角色、且确实没配时显示。
 *
 * 视觉这一档要多问一句：**主模型自己看得懂图的话，「视觉」空着完全没事** ——
 * 带图的请求会直接用主模型。判定与主进程选模型时用的是同一个函数，
 * 免得界面上写着「会报错」、实际却跑得好好的（反过来更糟）。
 */
function showMissing(role: ModelRole): boolean {
  if (roleValue(role) !== null) return false
  if (role === 'vision') {
    return findVisionCapableRole({ roles: roles.value, providers: providers.value }) === null
  }
  return ROLES_WITHOUT_FALLBACK.has(role)
}

async function handleRoleChange(role: ModelRole, value: string | undefined): Promise<void> {
  const binding = ((): { providerId: string; modelId: string } | null => {
    if (!value) return null
    const [providerId, ...rest] = value.split('::')
    // 模型 id 本身可能含冒号（如 'qwen3:8b'），所以只按第一个分隔符切
    return { providerId, modelId: rest.join('::') }
  })()

  const result = await state.setRole(role, binding)
  if (!result.ok) message.error(result.error || t('aiProvider.messages.saveFailed'))
}
</script>

<template>
  <section class="settings-section">
    <!--
      这里以前还有一个 <h4>模型来源</h4>。页面本身已经叫「模型」，下面第一块
      又叫「模型」—— 三层标题里有两层写着同一个词，占了整整一屏顶部。
      留下面那个（它带一句说明），上面这个删掉。
    -->
    <div v-if="!initialLoading && !configured" class="provider-banner warning">
      {{ $t('aiProvider.banner.notConfigured') }}
    </div>
    <div v-if="!initialLoading && !encryptionAvailable" class="provider-banner warning">
      {{ $t('aiProvider.banner.noEncryption') }}
    </div>

    <!-- 创作者 Token Plan：一个订阅配好多个角色。应用或断开后重读来源与绑定 -->
    <CreatorPlanCard @changed="state.load()" />

    <!-- 一、服务商 -->
    <div class="settings-subsection">
      <div class="subsection-title">{{ $t('aiProvider.sources.title') }}</div>
      <div class="setting-desc">{{ $t('aiProvider.sources.desc') }}</div>

      <div class="source-grid">
        <!-- 占位两张：Provider 通常两三个，多一张少一张真卡片到位时都会跳一下 -->
        <template v-if="initialLoading">
          <div
            v-for="i in 2"
            :key="`skeleton-${i}`"
            class="source-card source-card-loading"
            aria-hidden="true"
          >
            <a-skeleton active :title="{ width: '60%' }" :paragraph="{ rows: 1, width: ['45%'] }" />
          </div>
        </template>
        <template v-else>
          <button
            v-for="provider in providers"
            :key="provider.id"
            type="button"
            class="source-card"
            @click="openProvider(provider.id)"
          >
            <span class="source-name">{{ provider.displayName }}</span>
            <span class="source-meta">
              <span>{{ $t('aiProvider.list.modelCount', { count: provider.models.length }) }}</span>
              <span class="source-key" :class="keyStatus(provider).tone">
                {{ keyStatus(provider).text }}
              </span>
            </span>
          </button>
        </template>

        <button type="button" class="source-card source-add" @click="showCatalog = true">
          {{ $t('aiProvider.list.add') }}
        </button>
      </div>

      <p v-if="!initialLoading && providers.length === 0" class="setting-desc">
        {{ $t('aiProvider.list.empty') }}
      </p>
    </div>

    <!-- 二、角色绑定 -->
    <div class="settings-subsection">
      <div class="subsection-title">{{ $t('aiProvider.roles.title') }}</div>
      <div class="setting-desc">{{ $t('aiProvider.roles.desc') }}</div>

      <div class="role-list">
        <div v-for="role in ROLES" :key="role" class="setting-item">
          <div class="setting-info">
            <div class="setting-label">
              {{ $t(`aiProvider.roles.${role}`) }}
              <AppTooltip v-if="ROLES_WITH_MORE.has(role)" placement="top">
                <template #title>{{ $t(`aiProvider.roles.${role}More`) }}</template>
                <!-- button 而不是 span：tooltip 是这段说明唯一的出口，键盘走不到就等于没有 -->
                <button
                  type="button"
                  class="role-more"
                  :aria-label="$t('aiProvider.roles.moreLabel')"
                >
                  ?
                </button>
              </AppTooltip>
              <!-- 不回落的角色没配就是真用不了，代价得写在脸上；但加载没回来时只是「还不知道」 -->
              <span v-if="!initialLoading && showMissing(role)" class="role-missing">
                {{ $t(`aiProvider.roles.${role}Missing`) }}
              </span>
            </div>
            <div class="setting-desc">{{ $t(`aiProvider.roles.${role}Desc`) }}</div>
          </div>
          <!--
            占位与真下拉框同高（antd 的 controlHeight 就是 32px）、同宽（compact-select），
            数据到位时行高和右边缘都不跳。
          -->
          <a-skeleton-button
            v-if="initialLoading"
            active
            block
            class="compact-select"
            aria-hidden="true"
          />
          <a-select
            v-else
            :value="roleValue(role)"
            class="compact-select"
            allow-clear
            show-search
            option-filter-prop="label"
            option-label-prop="label"
            :placeholder="$t('aiProvider.roles.unset')"
            :aria-label="roleControlLabel(role)"
            :title="roleSelectionLabel(role) || undefined"
            @mouseenter="scrollSelectedTextToEnd"
            @mouseleave="resetSelectedText"
            @focus="scrollSelectedTextToEnd"
            @blur="resetSelectedText"
            @change="(value: string | undefined) => handleRoleChange(role, value)"
          >
            <a-select-opt-group
              v-for="group in groupsForRole(role)"
              :key="group.id"
              :label="group.name"
            >
              <a-select-option
                v-for="option in group.options"
                :key="option.value"
                :value="option.value"
                :label="option.label"
                :aria-label="option.label"
              >
                <span
                  class="model-option-name"
                  :title="option.label"
                  @mouseenter="scrollOptionTextToEnd"
                  @mouseleave="resetOptionText"
                >
                  {{ option.modelName }}
                </span>
              </a-select-option>
            </a-select-opt-group>
          </a-select>
        </div>
      </div>
    </div>

    <div class="provider-config-path">
      <span>{{ $t('aiProvider.configPath') }}</span>
      <code>{{ configPath }}</code>
      <AppButton variant="soft" size="medium" @click="state.revealConfig()">
        {{ $t('aiProvider.reveal') }}
      </AppButton>
    </div>

    <ModelManagerModal
      v-model:open="showManager"
      :state="state"
      @add-provider="handleAddFromManager"
    />

    <ProviderCatalogModal
      v-model:visible="showCatalog"
      :catalog="catalog"
      :existing-ids="providers.map((item) => item.id)"
      @pick="handlePickCatalog"
      @pick-custom="handlePickCustom"
    />
  </section>
</template>

<style scoped>
/*
 * settings-section / setting-item / setting-desc 这一套在每个设置面板里都是
 * **各自 scoped 各自写一遍** 的（ProfileAI、McpSettings、ProfileGeneral…），
 * 没有全局版本。这个文件当初照着别的面板抄了 class 名却没抄样式，于是
 * 整块退化成裸 div：角色一行摊成三行、下拉框各自按内容撑宽、行与行之间没有间距。
 * 补回来的这几条与 ProfileAI.vue 保持一致，别让「模型」页在设置里长得像个外人。
 */
/* 块级而不是 flex + gap：下面几块各自带 margin-top，两套间距会叠起来 */
.settings-section {
  display: block;
}

.section-title {
  margin: 0 0 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
  letter-spacing: 0.02em;
}

.setting-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
}

.setting-item + .setting-item {
  border-top: 1px solid var(--color-border-subtle);
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.setting-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-primary);
}

.setting-desc {
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-muted);
}

/*
 * 固定宽度，七个下拉框才对得齐；模型名在前，Provider 在后，截断时先保住模型名。
 */
.compact-select {
  flex: none;
  width: 360px;
}

.compact-select :deep(.ant-select-selection-item),
.model-option-name {
  overflow-x: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  scroll-behavior: smooth;
}

.compact-select :deep(.ant-select-selection-item::-webkit-scrollbar),
.model-option-name::-webkit-scrollbar {
  display: none;
}

.model-option-name {
  display: block;
  min-width: 0;
}

@media (prefers-reduced-motion: reduce) {
  .compact-select :deep(.ant-select-selection-item),
  .model-option-name {
    scroll-behavior: auto;
  }
}

@media (max-width: 768px) {
  .setting-item {
    align-items: stretch;
    flex-direction: column;
  }

  .compact-select {
    width: 100%;
  }
}

.role-more {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: 50%;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 10px;
  line-height: 1;
  cursor: help;
}

.role-more:hover,
.role-more:focus-visible {
  border-color: var(--color-accent-border);
  color: var(--color-text-secondary);
}

.role-missing {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--color-warning-bg);
  color: var(--color-warning-text);
  font-size: 11px;
}

.settings-subsection {
  margin-top: 24px;
}

.subsection-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-primary);
  margin-bottom: 4px;
}

/* 卡片网格：Provider 通常两三个，铺满一行反而扫不清 */
.source-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
  margin-top: 12px;
}

.source-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-bg-surface);
  text-align: left;
  cursor: pointer;
  transition: all 0.15s ease;
}

.source-card:hover {
  border-color: var(--color-accent-border);
  background: var(--color-accent-bg);
}

.source-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--color-text-muted);
}

/* 密钥没配好是最常见的故障，在列表上就得看出来 */
.source-key.ok {
  color: var(--color-success-text);
}

.source-key.warn {
  color: var(--color-danger-text);
}

.source-add {
  align-items: center;
  justify-content: center;
  border-style: dashed;
  color: var(--color-text-muted);
  font-size: 12px;
}

/* 占位卡片借了真卡片的壳，但它不可点，别把指针换成小手 */
.source-card-loading {
  cursor: default;
}

.role-list {
  margin-top: 12px;
}

.provider-config-path {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 24px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.provider-config-path code {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.provider-banner {
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.6;
  margin-bottom: 12px;
}

.provider-banner.warning {
  background: var(--color-warning-bg);
  color: var(--color-warning-text);
}
</style>
