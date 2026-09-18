<template>
  <div class="material-renderer">
    <section v-if="mode === 'preview'" class="preview-stage">
      <div class="preview-object" :class="entry.entryType">
        <img v-if="entry.thumbnail" :src="entry.thumbnail" alt="" />
        <span v-else>{{ previewInitial }}</span>
      </div>
      <div class="preview-meta">
        <strong>{{ entry.name }}</strong>
        <span>{{ entry.blendMode }} · {{ entry.shadingModel }}</span>
      </div>
    </section>

    <section v-else-if="mode === 'graph'" class="graph-stage">
      <div class="graph-summary">
        <div>
          <strong>{{ entry.graphSummary.nodeCount }}</strong>
          <span>{{ $t('materialRenderer.graph.nodeCount') }}</span>
        </div>
        <div>
          <strong>{{ entry.graphSummary.connectionCount }}</strong>
          <span>{{ $t('materialRenderer.graph.connectionCount') }}</span>
        </div>
        <div>
          <strong>{{ entry.graphSummary.textureNodeCount }}</strong>
          <span>{{ $t('materialRenderer.graph.textureNodeCount') }}</span>
        </div>
        <div>
          <strong>{{ entry.graphSummary.functionCallCount }}</strong>
          <span>{{ $t('materialRenderer.graph.functionCallCount') }}</span>
        </div>
      </div>
      <div class="graph-code-container">
        <button
          v-if="entry.graphBlueprintCode"
          type="button"
          class="copy-graph-btn"
          @click="copyGraphCode"
        >
          {{
            isCopied ? $t('materialRenderer.graph.copied') : $t('materialRenderer.graph.copyButton')
          }}
        </button>
        <BlueprintRenderer
          ref="blueprintRendererRef"
          class="material-graph-renderer"
          :code="entry.graphBlueprintCode || ''"
          :name="entry.name"
          @content-change="emit('content-change', $event)"
        />
      </div>
    </section>

    <section v-else class="parameter-stage">
      <div class="parameter-header">
        <div>
          <strong>{{ $t('materialRenderer.parameters.title') }}</strong>
          <span>{{ $t('materialRenderer.parameters.description') }}</span>
        </div>
        <b>{{ parameterTotal }}</b>
      </div>

      <div v-if="parameterTotal" class="parameter-groups">
        <div v-for="group in visibleParameterGroups" :key="group.title" class="parameter-group">
          <div class="parameter-group-title">
            <div>
              <span>{{ group.title }}</span>
              <small>{{ group.description }}</small>
            </div>
            <b>{{ group.items.length }}</b>
          </div>
          <div class="parameter-table">
            <div class="parameter-table-head">
              <span>{{ $t('materialRenderer.parameters.tableHead.name') }}</span>
              <span>{{ $t('materialRenderer.parameters.tableHead.type') }}</span>
              <span>{{ $t('materialRenderer.parameters.tableHead.value') }}</span>
              <span>{{ $t('materialRenderer.parameters.tableHead.source') }}</span>
            </div>
            <div
              v-for="item in group.items"
              :key="`${group.title}-${item.name}`"
              class="parameter-row"
            >
              <span class="parameter-name">{{ item.name }}</span>
              <em>{{ group.kind }}</em>
              <code
                :class="[
                  group.kind.toLowerCase(),
                  group.kind === 'Boolean'
                    ? getParameterDisplayValue(item)
                      ? 'val-true'
                      : 'val-false'
                    : ''
                ]"
                :title="formatMaterialValue(getParameterDisplayValue(item))"
              >
                {{ formatMaterialValue(getParameterDisplayValue(item)) }}
              </code>
              <b :class="{ overridden: isParameterOverridden(item) }">
                {{ getParameterSourceLabel(item) }}
              </b>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="empty-parameters">
        {{ $t('materialRenderer.parameters.empty') }}
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import BlueprintRenderer from '@renderer/views/BlueprintLibrary/BlueprintRenderer.vue'
import type { SelectedNodeInfo } from '@renderer/views/BlueprintLibrary/BlueprintRenderer.vue'
import type { MaterialEntry, MaterialParameterValue } from './types/material'
import { formatMaterialValue } from './types/material'
import { message } from '@/utils/messageManager'

const { t } = useI18n()

const props = defineProps<{
  entry: MaterialEntry
  mode: 'preview' | 'graph' | 'parameters'
}>()

const emit = defineEmits<{
  (event: 'content-change', code: string): void
}>()

const previewInitial = computed(() => props.entry.name.slice(0, 2).toUpperCase())
const blueprintRendererRef = ref<InstanceType<typeof BlueprintRenderer> | null>(null)

type ParameterGroup = {
  title: string
  kind: string
  description: string
  items: MaterialParameterValue[]
}

const parameterGroups = computed<ParameterGroup[]>(() => [
  {
    title: t('materialRenderer.parameters.groups.scalar.title'),
    kind: 'Scalar',
    description: t('materialRenderer.parameters.groups.scalar.desc'),
    items: props.entry.scalarParameters
  },
  {
    title: t('materialRenderer.parameters.groups.vector.title'),
    kind: 'Vector',
    description: t('materialRenderer.parameters.groups.vector.desc'),
    items: props.entry.vectorParameters
  },
  {
    title: t('materialRenderer.parameters.groups.texture.title'),
    kind: 'Texture',
    description: t('materialRenderer.parameters.groups.texture.desc'),
    items: props.entry.textureParameters
  },
  {
    title: t('materialRenderer.parameters.groups.boolean.title'),
    kind: 'Boolean',
    description: t('materialRenderer.parameters.groups.boolean.desc'),
    items: props.entry.staticSwitchParameters
  }
])

const visibleParameterGroups = computed(() =>
  parameterGroups.value.filter((group) => group.items.length > 0)
)

const parameterTotal = computed(() =>
  parameterGroups.value.reduce((total, group) => total + group.items.length, 0)
)

const isCopied = ref(false)

function getParameterDisplayValue(item: MaterialParameterValue): unknown {
  return item.overrideValue ?? item.inheritedValue
}

function isParameterOverridden(item: MaterialParameterValue): boolean {
  return item.isOverridden === true || item.overrideValue !== undefined
}

function getParameterSourceLabel(item: MaterialParameterValue): string {
  if (item.source === 'nodeProperty') return t('materialRenderer.parameters.source.nodeProperty')
  if (isParameterOverridden(item)) return t('materialRenderer.parameters.source.overridden')
  if (item.inheritedValue !== undefined) return t('materialRenderer.parameters.source.inherited')
  return t('materialRenderer.parameters.source.unknown')
}

async function copyGraphCode(): Promise<void> {
  if (!props.entry.graphBlueprintCode) return
  await navigator.clipboard.writeText(props.entry.graphBlueprintCode)
  isCopied.value = true
  message.success(t('materialRenderer.toast.copied'))
  setTimeout(() => {
    isCopied.value = false
  }, 2000)
}

function buildMaterialParameterNodeMatchers(parameterName: string): string[] {
  const [ownerName] = parameterName.split('.')
  if (!ownerName) return [parameterName]

  const expressionName = ownerName.startsWith('MaterialExpression')
    ? ownerName
    : `MaterialExpression${ownerName}`

  return [
    parameterName,
    ownerName,
    expressionName,
    `Name="${expressionName}"`,
    `MaterialExpression'"${expressionName}"'`
  ]
}

function focusOnMaterialParameter(
  parameterName: string
): { current: number; total: number } | null {
  return (
    blueprintRendererRef.value?.focusOnNodeByMatchers?.(
      buildMaterialParameterNodeMatchers(parameterName)
    ) ?? null
  )
}

function getSelectedNodesInfo(): SelectedNodeInfo[] {
  return blueprintRendererRef.value?.getSelectedNodesInfo?.() ?? []
}

defineExpose({
  focusOnMaterialParameter,
  getSelectedNodesInfo
})
</script>

<style scoped lang="less">
.material-renderer {
  min-height: 0;
  height: 100%;
}

.preview-stage,
.graph-stage,
.parameter-stage {
  height: 100%;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface-hover);
  border-radius: 6px;
  overflow: hidden;
}

.preview-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
}

.preview-object {
  width: min(360px, 48vh);
  aspect-ratio: 1;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--color-warning-on-solid);
  font-size: 42px;
  font-weight: 700;
  background: var(--color-warning-solid);
  box-shadow: inset -34px -42px 68px var(--shadow-color);
  overflow: hidden;
}

.preview-object.instance {
  background: var(--color-accent-bg);
}

.preview-object.function {
  border-radius: 8px;
  background:
    radial-gradient(
      circle at 30% 22%,
      rgba(255, 255, 255, 0.52),
      transparent 0 14%,
      transparent 34%
    ),
    linear-gradient(135deg, var(--color-bg-surface), #3f7a5d 52%, var(--color-bg-page));
}

.preview-object img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.preview-meta {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: var(--color-text-primary);
}

.preview-meta strong {
  color: var(--color-text-primary);
}

.graph-stage {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.graph-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border-bottom: 1px solid var(--color-border-subtle);
}

.graph-summary div {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.graph-summary strong {
  color: var(--color-text-primary);
  font-size: 18px;
}

.graph-summary span {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.graph-code-container {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.material-graph-renderer {
  flex: 1;
  min-height: 0;
}

.copy-graph-btn {
  position: absolute;
  right: 14px;
  top: 14px;
  height: 28px;
  padding: 0 10px;
  background: var(--color-bg-overlay);
  backdrop-filter: blur(4px);
  border: 1px solid var(--color-border-subtle);
  border-radius: 4px;
  color: var(--color-text-on-solid);
  font-size: 11px;
  cursor: pointer;
  z-index: 10;
  transition: all 0.15s ease;
}

.copy-graph-btn:hover {
  background: var(--color-bg-surface);
  color: var(--color-text-primary);
  border-color: var(--color-accent-border);
}

.parameter-stage {
  overflow: auto;
  padding: 14px;
}

.parameter-header {
  min-height: 54px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 12px;
  margin-bottom: 12px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 4px;
  background: var(--color-bg-surface-hover);
}

.parameter-header div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.parameter-header strong {
  color: var(--color-text-primary);
  font-size: 14px;
}

.parameter-header span {
  color: var(--color-text-secondary);
  font-size: 12px;
}

.parameter-header b {
  color: var(--color-text-primary);
  font-size: 18px;
}

.parameter-groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.parameter-group {
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface-hover);
  border-radius: 4px;
  overflow: hidden;
}

.parameter-group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 12px;
  color: var(--color-text-primary);
  border-bottom: 1px solid var(--color-border-subtle);
}

.parameter-group-title div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.parameter-group-title span {
  font-size: 13px;
  font-weight: 600;
}

.parameter-group-title small {
  color: var(--color-text-secondary);
  font-size: 11px;
}

.parameter-group-title b {
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 500;
}

.parameter-table-head,
.parameter-row {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) 110px minmax(0, 1.1fr) 84px;
  align-items: center;
  gap: 14px;
}

.parameter-table-head {
  padding: 7px 12px;
  color: var(--color-text-muted);
  font-size: 11px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.parameter-row {
  min-height: 42px;
  padding: 8px 12px;
  color: var(--color-text-primary);
  border-top: 1px solid var(--color-border-subtle);
  transition: background-color 0.15s ease;
}

.parameter-row:hover {
  background: var(--color-bg-surface-hover);
}

.parameter-name,
.parameter-row code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.parameter-name {
  color: var(--color-text-primary);
  font-size: 13px;
}

.parameter-row em {
  color: var(--color-text-secondary);
  font-size: 12px;
  font-style: normal;
}

.parameter-row code {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
  justify-self: start;
  max-width: 100%;
}

.parameter-row code.scalar {
  color: var(--color-warning-text);
  background: var(--color-warning-bg);
}

.parameter-row code.boolean.val-true {
  color: var(--color-success-text);
  background: var(--color-success-bg);
}

.parameter-row code.boolean.val-false {
  color: var(--color-text-secondary);
  background: var(--color-bg-surface-hover);
}

.parameter-row code.vector {
  color: var(--color-accent-text);
  background: var(--color-accent-bg);
}

.parameter-row code.texture {
  color: var(--color-accent-text);
  background: var(--color-accent-bg);
}

.parameter-row b {
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 500;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
  padding: 2px 6px;
  border-radius: 4px;
  justify-self: start;
  width: fit-content;
}

.parameter-row b.overridden {
  color: var(--color-accent-text);
  background: var(--color-accent-bg);
  border-color: var(--color-accent-border);
}

.empty-parameters {
  display: grid;
  place-items: center;
  min-height: 150px;
  color: var(--color-text-secondary);
  border: 1px dashed var(--color-border);
  border-radius: 4px;
  background: var(--color-bg-surface-hover);
  font-size: 13px;
}
</style>
