<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { PhGear } from '@phosphor-icons/vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

const props = defineProps<{ collapsed: boolean }>()
const router = useRouter()
const { t } = useI18n()
const appVersion = ref<string>('...')

onMounted(async () => {
  try {
    const info = await window.api.system.getInfo()
    appVersion.value = info?.appVersion || 'unknown'
  } catch (error) {
    console.error('Failed to load app version:', error)
    appVersion.value = 'unknown'
  }
})

function handleGoPreferences(): void {
  router.push('/preferences')
}
</script>

<template>
  <button
    type="button"
    :class="['preferences-shortcut', { collapsed: props.collapsed }]"
    :aria-label="t('common.preferences')"
    @click="handleGoPreferences"
  >
    <PhGear :size="22" class="preferences-icon" aria-hidden="true" />
    <span v-if="!props.collapsed" class="version">v{{ appVersion }}</span>
  </button>
</template>

<style scoped lang="less">
.preferences-shortcut {
  position: relative;
  flex: none;
  width: 100%;
  min-height: 48px;
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 9px 15px;
  border: 0;
  border-top: 1px solid var(--color-border-subtle);
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--motion-fast) var(--easing-standard),
    color var(--motion-fast) var(--easing-standard);

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }

  &:active {
    background: var(--color-bg-surface-hover);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: -2px;
  }

  &.collapsed {
    justify-content: center;
    padding-inline: 0;
  }

  .preferences-icon {
    flex: none;
  }

  .version {
    min-width: 0;
    overflow: hidden;
    color: inherit;
    font-size: 14px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

@media (prefers-reduced-motion: reduce) {
  .preferences-shortcut {
    transition: none;
  }
}
</style>
