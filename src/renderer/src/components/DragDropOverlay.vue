<template>
  <div v-if="visible" class="drag-overlay">
    <div class="drag-content">
      <div class="drag-icon">
        <svg
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M14 2H6C4.9 2 4 2.9 4 4V20C4 21.1 4.89 22 5.99 22H18C19.1 22 20 21.1 20 20V8L14 2Z"
            stroke="currentColor"
            stroke-width="2"
            fill="none"
          />
          <path d="M14 2V8H20" stroke="currentColor" stroke-width="2" fill="none" />
          <path d="M12 18L8 14L12 10" stroke="currentColor" stroke-width="2" fill="none" />
          <path d="M8 14H16" stroke="currentColor" stroke-width="2" fill="none" />
        </svg>
      </div>
      <div class="drag-text">
        <h3>{{ titleText }}</h3>
        <p>{{ descText }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

interface Props {
  visible: boolean
  title?: string
  desc?: string
}

const { t } = useI18n()

const props = defineProps<Props>()

/*
 * 文案兜底放在 computed 里，不放 withDefaults。
 *
 * `withDefaults` 的默认值要在编译期求值，调不了 `t()` —— 原来那两句写死的中文
 * 就是这么来的：调用方不传时，中英文用户看到的都是中文。
 */
const titleText = computed(() => props.title || t('actionToast.project.dropToImport'))
const descText = computed(() => props.desc || t('actionToast.project.dropToImportDesc'))
</script>

<style lang="less" scoped>
.drag-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--color-accent-bg);
  backdrop-filter: blur(4px);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed var(--color-accent-border);
  border-radius: var(--radius-sm);
  pointer-events: none; /* 让拖拽事件穿透覆盖层，到达底层的 drop 处理器 */

  .drag-content {
    text-align: center;
    color: var(--color-accent-text);

    .drag-icon {
      margin-bottom: 16px;

      svg {
        color: var(--color-accent-text);
        opacity: 0.8;
      }
    }

    .drag-text {
      h3 {
        margin: 0 0 8px 0;
        font-size: 18px;
        font-weight: 600;
        color: var(--color-accent-text);
      }

      p {
        margin: 0;
        font-size: 14px;
        color: var(--color-accent-text);
        opacity: 0.8;
      }
    }
  }
}
</style>
