<template>
  <div
    id="assistant-skill-command-menu"
    ref="menuRef"
    class="skill-command-menu"
    role="listbox"
    :aria-label="t('assistantInputComposer.skillMenu.title')"
  >
    <div class="skill-menu-header">
      <span class="skill-menu-title">{{ t('assistantInputComposer.skillMenu.title') }}</span>
      <span class="skill-menu-hint">{{ t('assistantInputComposer.skillMenu.hint') }}</span>
    </div>

    <!--
      两组共用**一个**滚动区。
      各自设最大高度的话，命令组把技能组往下顶，加起来超过面板高度就被
      `overflow: hidden` 裁掉 —— 表现是技能明明在命令下面，却滚不到、看不见。
    -->
    <div class="skill-menu-scroll">
      <!--
      命令组在技能组之前，而且**不等技能加载完**。
      命令是本地常量，技能要走一次 IPC —— 让确定的东西等不确定的东西，
      结果就是打 /goal 时先盯半秒「加载中」。
    -->
      <div v-if="filteredCommands.length > 0" class="skill-command-list">
        <div class="skill-group-label">
          {{ t('assistantInputComposer.skillMenu.groupCommands') }}
        </div>
        <button
          v-for="(command, index) in filteredCommands"
          :id="`assistant-skill-option-${index}`"
          :key="command.name"
          type="button"
          role="option"
          class="skill-command-item"
          :class="{ selected: index === selectedIndex }"
          :aria-selected="index === selectedIndex"
          @mouseenter="selectedIndex = index"
          @mousedown.prevent
          @click="selectAt(index)"
        >
          <span class="skill-command-name">
            <span class="skill-prefix">/</span>{{ command.name }}
            <span v-if="command.argHintKey" class="command-arg">{{ t(command.argHintKey) }}</span>
          </span>
          <span class="skill-command-meta">
            <span class="skill-description">{{ t(command.descriptionKey) }}</span>
          </span>
        </button>
      </div>

      <div v-if="loading" class="skill-menu-state" aria-live="polite">
        {{ t('assistantInputComposer.skillMenu.loading') }}
      </div>

      <div v-else-if="error" class="skill-menu-state skill-menu-error" aria-live="polite">
        <span>{{ t('assistantInputComposer.skillMenu.loadFailed') }}</span>
        <button type="button" class="skill-menu-retry" @click="$emit('retry')">
          {{ t('assistantInputComposer.skillMenu.retry') }}
        </button>
      </div>

      <!-- 命令命中了就不必再说「没有技能」—— 面板明明给出了东西 -->
      <div
        v-else-if="filteredSkills.length === 0 && filteredCommands.length === 0"
        class="skill-menu-state"
        aria-live="polite"
      >
        {{ t('assistantInputComposer.skillMenu.empty') }}
      </div>

      <div v-else-if="filteredSkills.length > 0" class="skill-command-list">
        <div v-if="filteredCommands.length > 0" class="skill-group-label">
          {{ t('assistantInputComposer.skillMenu.groupSkills') }}
        </div>
        <button
          v-for="(skill, index) in filteredSkills"
          :id="`assistant-skill-option-${filteredCommands.length + index}`"
          :key="skill.name"
          type="button"
          role="option"
          class="skill-command-item"
          :class="{ selected: filteredCommands.length + index === selectedIndex }"
          :aria-selected="filteredCommands.length + index === selectedIndex"
          @mouseenter="selectedIndex = filteredCommands.length + index"
          @mousedown.prevent
          @click="selectAt(filteredCommands.length + index)"
        >
          <span class="skill-command-name"
            ><span class="skill-prefix">$</span>{{ skill.name }}</span
          >
          <span class="skill-command-meta">
            <span class="skill-source">{{ sourceLabel(skill.source) }}</span>
            <span aria-hidden="true">·</span>
            <span class="skill-description">{{ skill.description }}</span>
          </span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AgentV3SkillSummary } from '@/api/agentV3'
import { filterSkillCommands } from './skillCommands'
import { filterSlashCommands, type SlashCommand } from './slashCommands'

const props = withDefaults(
  defineProps<{
    skills: AgentV3SkillSummary[]
    query: string
    loading?: boolean
    error?: string
  }>(),
  {
    loading: false,
    error: ''
  }
)

const emit = defineEmits<{
  (event: 'select', skill: AgentV3SkillSummary): void
  (event: 'select-command', command: SlashCommand): void
  (event: 'retry'): void
  (event: 'close'): void
}>()

const { t } = useI18n()
const menuRef = ref<HTMLElement | null>(null)
const selectedIndex = ref(0)
const filteredCommands = computed(() => filterSlashCommands(props.query))
const filteredSkills = computed(() =>
  props.loading || props.error ? [] : filterSkillCommands(props.skills, props.query)
)

/**
 * 键盘导航把两组拉平成一条：命令在前，技能在后。
 *
 * 分开两个下标的话，↓ 从命令组末尾走到技能组第一条时要在组件里判一次边界，
 * 那种判断每加一组就得重写一遍。
 */
const optionCount = computed(() => filteredCommands.value.length + filteredSkills.value.length)

watch([() => props.query, optionCount], () => {
  selectedIndex.value = 0
})

watch(selectedIndex, async () => {
  await nextTick()
  const active = menuRef.value?.querySelector<HTMLElement>('.skill-command-item.selected')
  if (typeof active?.scrollIntoView === 'function') {
    active.scrollIntoView({ block: 'nearest' })
  }
})

function sourceLabel(source: AgentV3SkillSummary['source']): string {
  return t(`assistantInputComposer.skillMenu.source.${source}`)
}

function moveSelection(delta: number): void {
  const count = optionCount.value
  if (count === 0) return
  selectedIndex.value = (selectedIndex.value + delta + count) % count
}

function selectAt(index = selectedIndex.value): void {
  const command = filteredCommands.value[index]
  if (command) {
    emit('select-command', command)
    return
  }

  const skill = filteredSkills.value[index - filteredCommands.value.length]
  if (skill) emit('select', skill)
}

function onKeydown(event: KeyboardEvent): boolean {
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('close')
    return true
  }

  // 技能还在加载时不能拿回车赌一个还没到的列表。但命令是本地常量，
  // 已经列在那儿了就该能选 —— 让它陪着技能一起等是白等。
  if (props.loading && filteredCommands.value.length === 0) {
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      return true
    }
  }

  if (optionCount.value === 0) return false

  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault()
    moveSelection(event.key === 'ArrowUp' ? -1 : 1)
    return true
  }

  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault()
    selectAt()
    return true
  }

  return false
}

defineExpose({ onKeydown })
</script>

<style scoped lang="less">
.skill-command-menu {
  position: absolute;
  inset-inline: 0;
  bottom: calc(100% + var(--space-2));
  z-index: 20;
  display: flex;
  flex-direction: column;
  max-height: min(360px, 50vh);
  overflow: hidden;
  padding: var(--space-2);
  color: var(--color-text-primary);
  background: var(--color-bg-raised);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-container);
  box-shadow: var(--shadow-menu);
}

.skill-menu-header {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-2) var(--space-2);
  border-bottom: 1px solid var(--color-border-subtle);
}

.skill-menu-title {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
}

.skill-menu-hint,
.skill-command-meta,
.skill-menu-state {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

// 唯一的滚动区：命令组和技能组都在里面，一起滚，谁也不会被裁掉
.skill-menu-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding-top: var(--space-1);
}

.skill-command-list {
  padding-top: var(--space-1);
}

.skill-group-label {
  padding: var(--space-1) var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.04em;
}

// 参数占位比命令名弱一档：它说的是「这儿该写什么」，不是命令的一部分
.command-arg {
  color: var(--color-text-muted);
  font-weight: var(--font-weight-regular);
}

.skill-command-item {
  display: flex;
  width: 100%;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  color: var(--color-text-primary);
  text-align: start;
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--motion-fast) var(--easing-standard);

  /* 鼠标划过 ≠ 键盘选中，两者不能同色，否则回车执行哪条只能靠猜 */
  &:hover {
    background: var(--color-bg-surface-hover);
  }

  &.selected {
    background: var(--color-bg-selected);
    box-shadow: inset 2px 0 var(--color-accent-border);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: -2px;
  }
}

.skill-command-name {
  max-width: 100%;
  overflow: hidden;
  font-family: var(--font-family-mono);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-prefix,
.skill-source {
  color: var(--color-accent-text);
}

.skill-command-meta {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: var(--space-1);
}

.skill-source {
  flex: none;
}

.skill-description {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-menu-state {
  display: flex;
  min-height: var(--space-10);
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-4);
  text-align: center;
}

.skill-menu-error {
  color: var(--color-text-secondary);
}

.skill-menu-retry {
  padding: var(--space-1) var(--space-2);
  color: var(--color-accent-text);
  background: var(--color-accent-bg);
  border: 1px solid var(--color-accent-border);
  border-radius: var(--radius-sm);
  cursor: pointer;

  &:hover,
  &:focus-visible {
    background: var(--color-accent-bg);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 2px;
  }
}
</style>
