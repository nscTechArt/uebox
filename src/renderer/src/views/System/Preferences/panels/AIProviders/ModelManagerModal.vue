<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import AppModal from '@renderer/components/AppModal.vue'
/**
 * 模型管理弹窗 —— **只有这一层**。
 *
 * 左侧一棵树（Provider，展开是它的模型），右侧是选中那个节点的详情。
 * 选中什么右边就换成什么，不再往下弹对话框：
 * 设置页 → 这个弹窗 → 完。再套一层用户就不知道自己在哪儿、点「取消」
 * 退的是哪一层了。
 *
 * 这个文件自己只管两件事：**树的选中状态** 和 **保存/删除/测试**。
 * 两个详情面板各自成组件（ProviderFields / ModelFields），
 * 免得又长回一个什么都干的大组件。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@renderer/utils/messageManager'
import { confirmDialog } from '@renderer/utils/dialog'
import { PROVIDER_KINDS, type ProviderKind, type ProviderView } from '@core/shared/aiProvider'
import type { AiProvidersState } from './useAiProviders'
import ProviderFields from './ProviderFields.vue'
import ModelFields from './ModelFields.vue'
import { Z_CONFIRM, Z_MANAGER } from './modalLayers'
import { describeProbeFailure } from './probeCopy'

const props = defineProps<{ open: boolean; state: AiProvidersState }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; addProvider: [] }>()

const { t } = useI18n()
const { draft, providers, isNew, isDirty, saving, testing, selectedId, configPath } = props.state

/**
 * 右侧显示谁。
 *
 * `provider` = 当前草稿本身；数字 = 草稿里第几个模型。
 * 换 Provider 时回到 provider ——「上一个 Provider 的第 3 个模型」
 * 在新 Provider 上多半不存在。
 */
const focus = ref<'provider' | number>('provider')

watch(
  () => [props.open, selectedId.value],
  () => {
    focus.value = 'provider'
    testStatus.value = null
    pending.value = null
  }
)

/** 选中的是模型时给出它的下标；选中 Provider 时为 null */
const focusedIndex = computed(() =>
  typeof focus.value === 'number' && draft.value?.models[focus.value] ? focus.value : null
)

const testStatus = ref<{ type: 'success' | 'error' | 'warning'; text: string } | null>(null)

/**
 * 「有未保存的修改，你确定要走吗」拦下来的那个动作。
 *
 * 之前是**静默丢弃**：改到一半点左边树换一个 Provider（或者右上角 ×），
 * `selectProvider` 直接把草稿覆盖掉，界面上没有任何提示，用户是过一阵子
 * 发现改动没生效才回来重做的。
 */
const pending = ref<(() => void) | null>(null)

/** 会离开当前草稿的动作都得从这儿走一遍 */
function guard(action: () => void): void {
  if (isDirty.value) {
    pending.value = action
    return
  }
  action()
}

/** 丢弃：不用手动还原草稿，pending 里的动作本身就会把它整个换掉 */
function discardPending(): void {
  const action = pending.value
  pending.value = null
  action?.()
}

/**
 * 先取出要做的事，再存盘。
 *
 * 顺序不能反：存一条**新建**的 Provider 会把 selectedId 从 null 变成新 id，
 * 上面那个 watch 跟着把 pending 清掉 —— 存完再去读就是 null，
 * 表现是「点了『保存并继续』，存是存上了，但没有继续」。
 */
async function savePending(): Promise<void> {
  const action = pending.value
  if (!(await doSave())) return
  pending.value = null
  action?.()
}

/**
 * 树按**用途**分组：对话、向量化、生图、视频、3D、实时语音。
 *
 * 十几条 Provider 平铺成一列时，「豆包实时语音」「GPT Image」「DeepSeek」混在
 * 一起，找生图那条得逐行读名字猜。而 kind 本来就是每条 Provider 的一个字段，
 * 用它分组不用再发明一套标签。顺序沿用 PROVIDER_KINDS，跟表单里「用途」下拉
 * 一致；没有 Provider 的组不渲染 —— 空标题只会让人以为漏了东西。
 *
 * 新建中的那条也归到它的用途组里（`draft.kind` 改了会跟着搬），否则它孤零零
 * 挂在最底下，用户在表单里选了「生图」却看见它待在「对话」下面。
 */
const groups = computed(() => {
  const byKind = new Map<ProviderKind, ProviderView[]>()
  for (const provider of providers.value) {
    byKind.set(provider.kind, [...(byKind.get(provider.kind) ?? []), provider])
  }
  const newKind = isNew.value && draft.value ? draft.value.kind : null
  return PROVIDER_KINDS.filter((kind) => byKind.has(kind) || kind === newKind).map((kind) => ({
    kind,
    providers: byKind.get(kind) ?? [],
    hasNew: kind === newKind
  }))
})

/**
 * 折叠状态只活在这次打开的弹窗里（destroy-on-close 会把它归零）。
 * 弹窗本来就是「进来改一下就走」，记住折叠反而会让下次打开时找不到东西。
 */
const collapsed = ref<Set<ProviderKind>>(new Set())

function toggleGroup(kind: ProviderKind): void {
  const next = new Set(collapsed.value)
  if (next.has(kind)) next.delete(kind)
  else next.add(kind)
  collapsed.value = next
}

function isCollapsed(kind: ProviderKind): boolean {
  return collapsed.value.has(kind)
}

/** 选中的那条所在的组永远展开着：折叠了再从别处切过来，右边在改一条左边看不见的东西 */
watch(
  () => [selectedId.value, isNew.value] as const,
  () => {
    const kind = isNew.value
      ? draft.value?.kind
      : providers.value.find((item) => item.id === selectedId.value)?.kind
    if (kind && collapsed.value.has(kind)) toggleGroup(kind)
  }
)

function pickProvider(providerId: string): void {
  guard(() => {
    props.state.selectProvider(providerId)
    focus.value = 'provider'
  })
}

function addModel(): void {
  if (!draft.value) return
  draft.value.models = [...draft.value.models, { id: '', supportsTools: true }]
  focus.value = draft.value.models.length - 1
}

function removeModel(index: number): void {
  if (!draft.value) return
  draft.value.models = draft.value.models.filter((_, i) => i !== index)
  // 删掉的正是当前选中的（或它前面的），焦点得跟着挪，否则右边显示的是别人
  if (focus.value === index) focus.value = 'provider'
  else if (typeof focus.value === 'number' && focus.value > index) focus.value -= 1
}

/** 树上模型那一行的名字。新加的还没填 id，给个占位，否则是一行空白 */
function modelLabel(model: { id: string; displayName?: string }): string {
  return model.displayName || model.id || t('aiProvider.model.untitled')
}

// ==================== 动作 ====================
/**
 * 校验并存盘，**不关弹窗**。
 *
 * 「保存」按钮存完要关，「保存并切换」存完要留在原地接着切 —— 关不关是
 * 调用方的事，存盘本身不该替它决定。
 */
async function doSave(): Promise<boolean> {
  const current = draft.value
  if (!current) return false

  if (!current.displayName.trim() && !current.id.trim()) {
    message.warning(t('aiProvider.validation.nameRequired'))
    return false
  }
  if (!current.baseUrl.trim()) {
    message.warning(t('aiProvider.validation.baseUrlRequired'))
    return false
  }

  const result = await props.state.save()
  if (!result.ok) {
    message.error(result.error || t('aiProvider.messages.saveFailed'))
    return false
  }
  message.success(t('aiProvider.messages.saved'))
  return true
}

async function handleSave(): Promise<void> {
  if (await doSave()) emit('update:open', false)
}

/**
 * 删除按钮**删的是右边正在看的那个东西**。
 *
 * 按钮放在详情面板的标题行而不是左侧树上：树是一眼扫过去、频繁点的东西，
 * 在那儿摆删除按钮，手滑的代价是连密钥带模型清单一起没了。
 *
 * 但位置挪对了，作用对象也得跟着挪 —— 之前不管右边显示的是 Provider 还是
 * 某个模型，它调的永远是「删掉整条 Provider」。按钮就贴在模型的「模型 ID /
 * 显示名」上面，谁都会以为删的是这个模型，一点下去连密钥、其余模型、
 * 指向它的角色绑定一起没。所以这里按 focusedIndex 分两条路，
 * 文案也各自写明删的是谁。
 */
const deleteLabel = computed(() =>
  focusedIndex.value !== null
    ? t('aiProvider.action.deleteModel')
    : t('aiProvider.action.deleteProvider')
)

/** 只从草稿里摘掉一个模型 —— 是编辑，不是存盘，点「保存」才落地 */
function deleteFocusedModel(index: number): void {
  const model = draft.value?.models[index]
  if (!model) return
  confirmDialog({
    title: t('aiProvider.deleteModel.title', { name: modelLabel(model) }),
    content: t('aiProvider.deleteModel.content'),
    okText: t('aiProvider.delete.ok'),
    danger: true,
    cancelText: t('aiProvider.delete.cancel'),
    zIndex: Z_CONFIRM,
    onOk: () => {
      removeModel(index)
    }
  })
}

/** 删掉整条 Provider：配置、已存的密钥、指向它的角色绑定一起没 */
function deleteProvider(providerId: string): void {
  confirmDialog({
    title: t('aiProvider.delete.title', { name: draft.value?.displayName || providerId }),
    content: t('aiProvider.delete.content'),
    okText: t('aiProvider.delete.ok'),
    danger: true,
    cancelText: t('aiProvider.delete.cancel'),
    zIndex: Z_CONFIRM,
    onOk: async () => {
      const result = await props.state.remove(providerId)
      if (result.ok) message.success(t('aiProvider.messages.deleted'))
      else message.error(result.error || t('aiProvider.messages.deleteFailed'))
    }
  })
}

function handleDelete(): void {
  if (focusedIndex.value !== null) {
    deleteFocusedModel(focusedIndex.value)
    return
  }
  if (selectedId.value) deleteProvider(selectedId.value)
}

async function handleImport(): Promise<void> {
  const result = await props.state.importModels()
  if (!result.ok) {
    // describeProbeFailure 每条路径都回非空串，不用再兜一层
    message.error(describeProbeFailure(result.error))
    return
  }
  message.success(t('aiProvider.messages.imported', { count: result.count ?? 0 }))
}

/**
 * 测试连接。结果留在弹窗里而不是飘一个 toast ——
 * 厂商的报错往往是一整段，toast 三秒就没了，用户来不及读完更来不及照着改。
 */
async function handleTest(): Promise<void> {
  const modelId = draft.value?.models.find((model) => model.id.trim())?.id.trim()
  if (!modelId) {
    message.warning(t('aiProvider.validation.modelRequired'))
    return
  }

  testStatus.value = null
  const result = await props.state.test(modelId)
  // 没真发请求的那一档要显示成提示而不是「通过」—— 绿勾会让用户以为密钥验过了
  testStatus.value = !result.ok
    ? { type: 'error', text: describeProbeFailure(result.error) }
    : result.skipped
      ? { type: 'warning', text: t(`aiProvider.probeSkip.${result.skipped}`) }
      : { type: 'success', text: t('aiProvider.messages.testOk', { model: modelId }) }
}

function close(): void {
  guard(() => {
    props.state.cancelEdit()
    emit('update:open', false)
  })
}

/** 「+ 添加 Provider」会把草稿换成一条新的，跟切换 Provider 是同一类离开 */
function addProvider(): void {
  guard(() => emit('addProvider'))
}
</script>

<template>
  <AppModal
    :open="open"
    hide-footer
    :width="900"
    :body-style="{ padding: '0' }"
    :z-index="Z_MANAGER"
    centered
    destroy-on-close
    @cancel="close"
    @update:open="!$event && close()"
  >
    <template #title>
      <span class="modal-title">
        {{ $t('aiProvider.title') }}
        <code class="modal-path">{{ configPath }}</code>
      </span>
    </template>

    <div class="manager">
      <!-- 左：Provider → 模型 的树。选中什么右边就换成什么 -->
      <nav class="tree">
        <div class="tree-scroll">
          <section v-for="group in groups" :key="group.kind" class="tree-group">
            <button
              type="button"
              class="tree-group-title"
              :aria-expanded="!isCollapsed(group.kind)"
              @click="toggleGroup(group.kind)"
            >
              <span class="tree-caret" :class="{ open: !isCollapsed(group.kind) }">›</span>
              <span class="tree-group-name">{{ $t(`aiProvider.field.kinds.${group.kind}`) }}</span>
              <span class="tree-group-count">{{
                group.providers.length + (group.hasNew ? 1 : 0)
              }}</span>
            </button>

            <template v-if="!isCollapsed(group.kind)">
              <template v-for="provider in group.providers" :key="provider.id">
                <button
                  type="button"
                  class="tree-provider"
                  :class="{ active: selectedId === provider.id && !isNew }"
                  @click="pickProvider(provider.id)"
                >
                  <span class="tree-provider-name">{{ provider.displayName }}</span>
                  <!-- 改过还没存的那条带个点，否则「切走会丢东西」只有拦截弹窗才说得出来 -->
                  <span
                    v-if="selectedId === provider.id && !isNew && isDirty"
                    class="tree-dirty"
                    :title="$t('aiProvider.unsaved.dot')"
                  />
                </button>

                <!-- 只展开当前这一条：全展开的话十几个模型就把树撑爆了 -->
                <template v-if="selectedId === provider.id && !isNew && draft">
                  <button
                    v-for="(model, index) in draft.models"
                    :key="index"
                    type="button"
                    class="tree-model"
                    :class="{ active: focus === index }"
                    @click="focus = index"
                  >
                    <span class="tree-model-name">{{ modelLabel(model) }}</span>
                    <span class="tree-model-remove" @click.stop="removeModel(index)">×</span>
                  </button>
                  <button type="button" class="tree-model tree-add" @click="addModel">
                    {{ $t('aiProvider.field.addModel') }}
                  </button>
                </template>
              </template>

              <!-- 新建中的那条还不在 providers 里，单独渲染一次，放在它用途对应的组里 -->
              <template v-if="group.hasNew && draft">
                <button type="button" class="tree-provider active" @click="focus = 'provider'">
                  {{ draft.displayName || draft.id || $t('aiProvider.editor.addTitle') }}
                </button>
                <button
                  v-for="(model, index) in draft.models"
                  :key="`new-${index}`"
                  type="button"
                  class="tree-model"
                  :class="{ active: focus === index }"
                  @click="focus = index"
                >
                  <span class="tree-model-name">{{ modelLabel(model) }}</span>
                  <span class="tree-model-remove" @click.stop="removeModel(index)">×</span>
                </button>
                <button type="button" class="tree-model tree-add" @click="addModel">
                  {{ $t('aiProvider.field.addModel') }}
                </button>
              </template>
            </template>
          </section>
        </div>

        <button type="button" class="tree-add-provider" @click="addProvider">
          {{ $t('aiProvider.list.add') }}
        </button>
      </nav>

      <!-- 右：详情 -->
      <div class="detail">
        <div v-if="!draft" class="detail-empty">{{ $t('aiProvider.editor.pickOne') }}</div>

        <template v-else>
          <div class="detail-actions">
            <!--
              看模型时永远能删（连新建中的草稿也能，那只是从清单里摘一条）；
              看 Provider 时只有已存盘的才给删 —— 新建中的直接点「关闭」就没了，
              摆个「删除 Provider」只会让人以为要删的是别的东西。
            -->
            <AppButton
              v-if="focusedIndex !== null || (!isNew && selectedId)"
              variant="soft"
              size="medium"
              danger
              @click="handleDelete"
            >
              {{ deleteLabel }}
            </AppButton>
          </div>

          <ModelFields v-if="focusedIndex !== null" :state="state" :index="focusedIndex" />
          <ProviderFields v-else :state="state" @import="handleImport" />
        </template>
      </div>
    </div>

    <footer class="manager-footer">
      <div v-if="testStatus" class="test-status" :class="testStatus.type">
        {{ testStatus.text }}
      </div>
      <div class="footer-actions">
        <AppButton variant="soft" :disabled="testing || !draft" @click="handleTest">
          {{ testing ? $t('aiProvider.action.testing') : $t('aiProvider.action.test') }}
        </AppButton>
        <!-- 它调的就是关闭。以前叫「撤销修改」，可它一个字都没撤销 -->
        <AppButton variant="soft" @click="close">
          {{ $t('aiProvider.action.close') }}
        </AppButton>
        <AppButton variant="primary" :disabled="saving || !draft" @click="handleSave">
          {{ saving ? $t('aiProvider.action.saving') : $t('aiProvider.action.save') }}
        </AppButton>
      </div>
    </footer>

    <!--
      未保存拦截。三个选项而不是「确定/取消」：真正想要的多半是「存了再走」，
      逼用户先取消、再点保存、再点一次原来那个动作只是把步骤摊开。
    -->
    <AppModal
      :open="pending !== null"
      hide-footer
      :width="420"
      :z-index="Z_CONFIRM"
      centered
      :mask-closable="false"
      :title="$t('aiProvider.unsaved.title')"
      @cancel="pending = null"
    >
      <p class="unsaved-text">{{ $t('aiProvider.unsaved.content') }}</p>
      <div class="unsaved-actions">
        <AppButton variant="soft" @click="pending = null">
          {{ $t('aiProvider.unsaved.stay') }}
        </AppButton>
        <AppButton variant="soft" danger @click="discardPending">
          {{ $t('aiProvider.unsaved.discard') }}
        </AppButton>
        <AppButton variant="primary" :disabled="saving" @click="savePending">
          {{ saving ? $t('aiProvider.action.saving') : $t('aiProvider.unsaved.save') }}
        </AppButton>
      </div>
    </AppModal>
  </AppModal>
</template>

<style scoped>
.modal-title {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

/* 配置文件路径挂在标题上：用户随时能自己去改那个文件，得知道它在哪儿 */
.modal-path {
  font-size: 11px;
  font-weight: 400;
  color: var(--color-text-muted);
}

/*
 * 高度**固定一个百分比**，不是 min/max 夹出来的一个区间。
 *
 * 原来是 `min-height: 460px; max-height: 60vh` —— 那是个范围，弹窗实际多高
 * 由内容决定：点一个只有 1 个模型的 Provider 和点一个有 8 个模型的，
 * 弹窗自己会长高缩矮；在 Provider 面板和模型面板之间来回切也是。弹窗是
 * 居中的，高度一变整块跟着上下跳，正在点的那个按钮就从鼠标底下跑掉了。
 *
 * 而且那两个值在窄屏上还会打架：视口不到 767px 时 60vh 已经小于 460px，
 * min 赢，弹窗反而超出 60vh。
 *
 * 所以只留一个 vh 值。两列各自内部滚动，内容多少都不影响外框。
 */
.manager {
  display: grid;
  grid-template-columns: 220px 1fr;
  height: 70vh;
}

.tree {
  display: flex;
  flex-direction: column;
  /* grid 子项默认 min-height:auto，不压成 0 的话里面的 overflow 撑不住 */
  min-height: 0;
  border-right: 1px solid var(--color-border);
}

.tree-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 8px 12px 0;
}

/* 组与组之间留一点空，标题才不会看起来像上一组的最后一条 */
.tree-group + .tree-group {
  margin-top: 8px;
}

.tree-group-title {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 4px 0px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-align: left;
  cursor: pointer;
  user-select: none;
}

.tree-group-title:hover {
  background: var(--color-bg-surface-hover);
  color: var(--color-text-secondary);
}

.tree-caret {
  display: inline-block;
  width: 10px;
  font-size: 13px;
  line-height: 1;
  transition: transform 0.15s ease-in-out;
}

.tree-caret.open {
  transform: rotate(90deg);
}

.tree-group-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-group-count {
  flex-shrink: 0;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
}

.tree-provider {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 14px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-primary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.tree-provider-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-dirty {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-warning-solid);
}

.tree-provider:hover {
  background: var(--color-bg-surface-hover);
}

.tree-provider.active {
  background: var(--color-bg-selected);
}

/* 模型缩进一级，一眼看得出从属关系 */
.tree-model {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px 6px 24px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.tree-model:hover {
  background: var(--color-bg-surface-hover);
}

.tree-model.active {
  background: var(--color-bg-selected);
  color: var(--color-text-primary);
}

.tree-model-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-model-remove {
  flex-shrink: 0;
  opacity: 0;
  font-size: 14px;
  color: var(--color-text-muted);
}

.tree-model:hover .tree-model-remove {
  opacity: 1;
}

.tree-model-remove:hover {
  color: var(--color-danger-text);
}

.tree-add {
  color: var(--color-text-muted);
}

.tree-add-provider {
  margin: 8px;
  padding: 8px;
  border: 1px dashed var(--color-border);
  border-radius: 8px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  cursor: pointer;
}

.tree-add-provider:hover {
  border-color: var(--color-accent-border);
}

.detail {
  min-height: 0;
  padding: 16px 20px;
  overflow-y: auto;
}

.detail-empty {
  padding: 40px 0;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-muted);
}

.detail-actions {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
  min-height: 24px;
}

/*
 * 固定高度，把「测试连接」的结果条那一行的位置先占住。
 *
 * 不占的话，弹窗高度还是会变：测试报错时结果条撑开页脚，整个居中的弹窗
 * 又往上下跳一次 —— 而这恰恰是用户正盯着看报错的时候。
 */
.manager-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 60px;
  padding: 0 20px;
  border-top: 1px solid var(--color-border);
}

.footer-actions {
  display: flex;
  gap: 8px;
  margin-left: auto;
}

.test-status {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.5;
  /* 报错可以很长，但它只能在自己这块里滚，不许把页脚顶高 */
  max-height: 36px;
  overflow-y: auto;
  word-break: break-word;
}

.test-status.success {
  background: var(--color-success-bg);
  color: var(--color-success-text);
}

.test-status.error {
  background: var(--color-danger-bg);
  color: var(--color-danger-text);
}

/* 「没测」这一档。刻意不用绿色：绿勾等于告诉用户密钥已经验过了 */
.test-status.warning {
  background: var(--color-warning-bg);
  color: var(--color-warning-text);
}

.unsaved-text {
  margin: 0 0 18px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--color-text-secondary);
}

.unsaved-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
