<script setup lang="ts">
/**
 * 导入弹窗里的一张工程卡。
 *
 * 卡面上只印名字 —— 封面经常认不出工程（没开过的用同一张默认缩略图），所以名字就是
 * 唯一的识别依据，给它两行。路径彻底不出现：卡面上是噪声，挂 title 悬停弹出来也是
 * 噪声，没人靠盘符和目录层级认工程。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCheck, PhPushPin } from '@phosphor-icons/vue'
import AppCard from '@renderer/components/AppCard.vue'
import type { ImportProjectChoice } from '../../utils/importProjectChoices'

const props = defineProps<{
  project: ImportProjectChoice
  image: string
  /** 已经翻译好的引擎版本，例如「UE 5.5」 */
  versionLabel: string
  connected: boolean
  selected: boolean
  disabled: boolean
}>()
const emit = defineEmits<{ select: [ImportProjectChoice] }>()
const { t } = useI18n()

const name = computed(() => props.project.projectName || t('importToProjectModal.unnamedProject'))
</script>

<template>
  <AppCard
    class="project-card"
    :class="{ selected }"
    :hoverable="true"
    :disabled="disabled"
    :aria-pressed="selected"
    :aria-label="name"
    @click="emit('select', project)"
  >
    <template #cover>
      <div class="card-cover">
        <img :src="image" alt="" />
        <span v-if="project.isPinned === 1" class="cover-badge">
          <PhPushPin weight="fill" aria-hidden="true" />
          {{ t('homeProjectCollection.badge.pinned') }}
        </span>
        <span v-if="selected" class="cover-check" :title="t('importToProjectModal.selected')">
          <PhCheck weight="bold" aria-hidden="true" />
        </span>
      </div>
    </template>
    <div class="card-info">
      <div class="card-name">{{ name }}</div>
      <div class="card-tags">
        <span class="tag-version" :title="project.EngineAssociation || ''">{{ versionLabel }}</span>
        <span v-if="connected" class="tag-connected">
          <span class="connected-dot" aria-hidden="true"></span>
          {{ t('importToProjectModal.connected') }}
        </span>
      </div>
    </div>
  </AppCard>
</template>

<style scoped>
.project-card {
  min-width: 0;
  text-align: left;
}
/* 选中态要一眼看见：描边 + 外环 + 底色，再加封面上那个对勾。
   用 accent 不用 success —— 绿色说的是「成功了」，这里只是「选中了」，
   导入还没发生。仓库里 selected/accent 就是这一档的语义色 */
.project-card.selected {
  border-color: var(--color-accent-border);
  background: var(--color-bg-selected);
  box-shadow: 0 0 0 2px var(--color-accent-border);
}
.card-cover {
  position: relative;
  width: 100%;
  /* UE 的关卡截图本来就是宽屏，按 1:1 裁会把画面切掉一大半 */
  aspect-ratio: 16 / 9;
  overflow: hidden;
  background: var(--color-bg-sunken);
}
.card-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover-badge {
  position: absolute;
  top: var(--space-2);
  left: var(--space-2);
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 2px var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-bg-overlay);
  color: var(--color-text-on-solid);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}
.cover-check {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--color-accent-solid);
  color: var(--color-text-on-solid);
}
.card-info {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  min-width: 0;
}
/* 名字是唯一的识别依据，最多两行。不写 min-height：短名字就该只占一行，
   同一行卡片的高度由 grid 自己拉齐（grid-auto-rows: max-content + 默认 stretch），
   不需要在这里先把每张卡都垫成两行高 */
.card-name {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  min-width: 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  line-height: 1.3;
}
.card-tags {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  font-size: var(--font-size-xs);
}
.tag-version {
  padding: 1px var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--color-bg-soft);
  color: var(--color-text-secondary);
}
.tag-connected {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--color-success-text);
}
.connected-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-success-solid);
}
</style>
