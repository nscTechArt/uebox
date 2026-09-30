<template>
  <!-- 签出角标（方案 2.2）：你签出绿色对勾；别人签出红色圆标写姓名首字；没人签出不显示。在看旧版时不显示 -->
  <span
    v-if="checkout && !teamStore.viewingOld"
    class="team-checkout-badge"
    :class="mine ? 'mine' : 'other'"
    :title="checkoutText"
  >
    <PhCheck v-if="mine" weight="bold" />
    <template v-else>{{ initial }}</template>
  </span>
  <!-- 参考里管理员新发来或更新过的（方案 4.12） -->
  <span v-if="isNewReference" class="team-new-dot" />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { PhCheck } from '@phosphor-icons/vue'
import { useTeamStore } from '@renderer/store/modules/teamStore'
import { checkoutLine } from './teamFormat'

const props = defineProps<{ path: string | null }>()
const { t } = useI18n()
const teamStore = useTeamStore()

const checkout = computed(() => teamStore.checkoutOf(props.path))
const mine = computed(() => checkout.value?.holder.id === teamStore.me)
const initial = computed(() => Array.from(checkout.value?.holder.name ?? '?')[0] ?? '?')
const checkoutText = computed(() =>
  checkout.value
    ? checkoutLine(checkout.value.holder, checkout.value.since, Date.now(), teamStore.me, t)
    : ''
)
const isNewReference = computed(
  () => teamStore.isOutsourcer && Boolean(props.path) && teamStore.isNewReference(props.path ?? '')
)
</script>

<style scoped lang="less">
.team-checkout-badge {
  position: absolute;
  top: var(--space-1);
  left: var(--space-1);
  z-index: 2;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-on-solid);

  &.mine {
    background: var(--color-success-solid);
  }

  &.other {
    background: var(--color-danger-solid);
  }
}

.team-new-dot {
  position: absolute;
  top: var(--space-1);
  right: var(--space-1);
  z-index: 2;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--color-danger-solid);
}
</style>
