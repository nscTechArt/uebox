<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { CreatorPlanRoutePrice, CreatorPlanVideoPrice } from '@core/shared/creatorPlanPricing'
defineProps<{ prices?: Record<string, CreatorPlanRoutePrice>; video?: CreatorPlanVideoPrice }>()
const { t, locale } = useI18n()
const dimensions = ['input', 'cached_input', 'output'] as const
const number = (value: number): string =>
  new Intl.NumberFormat(locale.value, { maximumFractionDigits: 6 }).format(value)
</script>
<template>
  <div class="plan-prices">
    <p>{{ t('aiProvider.creatorPlan.pricing.description') }}</p>
    <div v-for="(price, model) in prices" :key="model">
      <strong>{{ model }}</strong>
      <dl>
        <div v-for="dimension in dimensions" :key="dimension">
          <dt>{{ t('aiProvider.creatorPlan.pricing.' + dimension) }}</dt>
          <dd>
            {{ number(price.minimum[dimension]) }}–{{ number(price.maximum[dimension]) }}
            Credits/token
          </dd>
        </div>
      </dl>
    </div>
    <div v-if="video">
      <strong>uebox-video</strong>
      <p>{{ t('aiProvider.creatorPlan.pricing.videoTerms') }}</p>
      <dl>
        <div v-for="(range, variant) in video.variants" :key="variant">
          <dt>{{ variant }}</dt>
          <dd>{{ number(range.minimum) }}–{{ number(range.maximum) }} Credits/s</dd>
        </div>
      </dl>
    </div>
  </div>
</template>
<style scoped>
.plan-prices {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}
.plan-prices p {
  margin: var(--space-2) 0;
}
.plan-prices dl {
  margin: var(--space-2) 0;
}
.plan-prices dl > div {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--space-2);
}
.plan-prices dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
</style>
