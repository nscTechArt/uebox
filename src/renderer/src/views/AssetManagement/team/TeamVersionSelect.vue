<template>
  <AppDropdown v-model:open="open" placement="bottomLeft">
    <button class="version-pill" :class="{ old: modelValue !== 'latest' && highlightOld }">
      {{ label }} <PhCaretDown />
    </button>
    <template #overlay>
      <div class="version-menu" @click.stop>
        <AppMenu :selected-keys="[selectedKey]" @click="onPick">
          <AppMenuItem item-key="latest">
            <PhCheck v-if="modelValue === 'latest'" class="check" />{{
              t('teamProject.compare.latest')
            }}
          </AppMenuItem>
          <template v-if="shownMilestones.length > 0">
            <AppMenuDivider />
            <AppMenuItem
              v-for="m in shownMilestones"
              :key="`m${m.number}`"
              :item-key="`n${m.number}`"
            >
              <PhCheck v-if="modelValue === m.number" class="check" />
              <span class="milestone-tag">{{ m.name }}</span>
              <span class="muted">#{{ m.number }} · {{ formatTeamTime(m.at, now, t) }}</span>
            </AppMenuItem>
            <AppMenuSubmenu v-if="olderMilestones.length > 0">
              <template #title>{{ t('teamProject.compare.earlier') }}</template>
              <AppMenuItem
                v-for="m in olderMilestones"
                :key="`o${m.number}`"
                :item-key="`n${m.number}`"
              >
                <span class="milestone-tag">{{ m.name }}</span>
                <span class="muted">#{{ m.number }}</span>
              </AppMenuItem>
            </AppMenuSubmenu>
          </template>
          <template v-if="recent.length > 0">
            <AppMenuDivider />
            <AppMenuItem v-for="s in recent" :key="`r${s.number}`" :item-key="`n${s.number}`">
              <PhCheck v-if="modelValue === s.number" class="check" />
              <span class="muted">#{{ s.number }}</span> {{ s.message }}
            </AppMenuItem>
          </template>
        </AppMenu>
        <!-- 按提交号…（输入框，占位「#1496」） -->
        <div class="by-number">
          <span class="muted">{{ t('teamProject.compare.byNumber') }}</span>
          <a-input
            v-model:value="numberText"
            size="small"
            :placeholder="t('teamProject.compare.byNumberPlaceholder')"
            @press-enter="pickNumber"
          />
        </div>
      </div>
    </template>
  </AppDropdown>
</template>

<script setup lang="ts">
/**
 * 版本下拉（方案 2.19）：「最新」→ 里程碑（新的在上，最多 5 个，多了收进「更早的 ▸」）→「按提交号…」。
 * 对比的两个下拉在里程碑下面再列最近 10 次提交。当前所在的那一项前打勾。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCaretDown, PhCheck } from '@phosphor-icons/vue'
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import AppMenuDivider from '@renderer/components/AppMenuDivider.vue'
import AppMenuSubmenu from '@renderer/components/AppMenuSubmenu.vue'
import type { TeamMilestone, TeamSubmit } from '@core/shared/teamProject'
import { formatTeamTime } from './teamFormat'

const props = withDefaults(
  defineProps<{
    modelValue: number | 'latest'
    milestones: TeamMilestone[]
    recent?: Array<Pick<TeamSubmit, 'number' | 'message'>>
    highlightOld?: boolean
  }>(),
  { recent: () => [], highlightOld: false }
)
const emit = defineEmits<{ (e: 'update:modelValue', value: number | 'latest'): void }>()
const { t } = useI18n()

const open = ref(false)
const numberText = ref('')
const now = Date.now()
const shownMilestones = computed(() => props.milestones.slice(0, 5))
const olderMilestones = computed(() => props.milestones.slice(5))
const selectedKey = computed(() =>
  props.modelValue === 'latest' ? 'latest' : `n${props.modelValue}`
)
const label = computed(() => {
  if (props.modelValue === 'latest') return t('teamProject.compare.latest')
  const milestone = props.milestones.find((m) => m.number === props.modelValue)
  return milestone ? milestone.name : `#${props.modelValue}`
})

function onPick(info: { key: string }): void {
  if (info.key === 'latest') emit('update:modelValue', 'latest')
  else if (info.key.startsWith('n')) emit('update:modelValue', Number(info.key.slice(1)))
  open.value = false
}

function pickNumber(): void {
  const match = /^#?(\d+)$/.exec(numberText.value.trim())
  if (!match) return
  emit('update:modelValue', Number(match[1]))
  numberText.value = ''
  open.value = false
}
</script>

<style scoped lang="less">
.version-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-bg-surface);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;

  &.old {
    border-color: var(--color-accent-border);
    background: var(--color-accent-bg);
    color: var(--color-accent-text);
  }
}

.version-menu {
  min-width: 260px;
  max-height: 420px;
  overflow-y: auto;
  border-radius: var(--radius-md);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-menu);
}

.check {
  margin-right: var(--space-1);
}

.milestone-tag {
  margin-right: var(--space-2);
  padding: 0 var(--space-2);
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius-full);
  color: var(--color-warning-text);
  font-size: var(--font-size-xs);
}

.muted {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.by-number {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-top: 1px solid var(--color-border-subtle);
}
</style>
