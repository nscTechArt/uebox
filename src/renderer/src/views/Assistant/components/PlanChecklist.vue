<template>
  <!--
    Agent 用 update_plan 交出来的任务清单。整条回复只画最后一份，原地打勾。
    没有标题：一列带勾的短句自己就说明了是什么，再加一行「任务清单」是重复。
  -->
  <ul class="plan-checklist">
    <li v-for="(item, index) in items" :key="index" class="plan-item" :class="`is-${item.status}`">
      <PhCheckCircle v-if="item.status === 'completed'" weight="fill" class="plan-icon" />
      <PhCircleNotch
        v-else-if="item.status === 'in_progress' && live"
        class="plan-icon icon-spin"
      />
      <PhCircleHalf v-else-if="item.status === 'in_progress'" class="plan-icon" />
      <PhCircleDashed v-else class="plan-icon" />
      <span class="plan-text">{{ item.content }}</span>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { PhCheckCircle, PhCircleDashed, PhCircleHalf, PhCircleNotch } from '@phosphor-icons/vue'
import type { PlanItem } from '@core/shared/agentTurnReport'

defineProps<{
  items: PlanItem[]
  /** 这一轮还在跑：进行中那步转圈；停了就换成半圆，不让一个死掉的转圈骗人 */
  live: boolean
}>()
</script>

<style scoped lang="less">
.plan-checklist {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: var(--space-2) 0 0;
  padding: var(--space-3);
  list-style: none;
  border: 1px solid var(--color-border-subtle);
  border-radius: 12px;
}

.plan-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  line-height: 1.6;
  color: var(--color-text-secondary);

  &.is-in_progress {
    color: var(--color-text-primary);
  }

  &.is-completed .plan-text {
    color: var(--color-text-muted);
  }
}

.plan-icon {
  flex-shrink: 0;
  font-size: 16px;

  /* 做完的和没开始的都用弱一档的字色；靠图标（实心勾 / 虚线圈）区分，不靠更浅的颜色 */
  .is-completed > &,
  .is-pending > & {
    color: var(--color-text-muted);
  }
}
</style>
