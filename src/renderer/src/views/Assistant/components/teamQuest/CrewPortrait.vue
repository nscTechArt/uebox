<template>
  <canvas
    ref="canvasRef"
    class="crew-portrait"
    :width="PORTRAIT_W"
    :height="PORTRAIT_H"
    :style="{ width: `${PORTRAIT_W * unit}px`, height: `${PORTRAIT_H * unit}px` }"
    aria-hidden="true"
  />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { useMotionPreference } from '@renderer/hooks/useMotionPreference'

import type { ModelLook } from '../teamOffice/modelLook'
import type { Pose } from '../teamOffice/officeSim'
import { drawPortraitV2, PORTRAIT_H, PORTRAIT_W } from '../teamOffice/v2/drawV2'
import { cssPerPixel } from './pixelScale'

/**
 * 角色卡上的小人。和办公室里是同一个人（同一套画法、同一个发型和衬衫），
 * 只是单独画在一块小画布上。动作跟着他在干嘛走：写、喝、捂脸、举手。
 * 减少动效时只画一帧。
 */
const props = withDefaults(
  defineProps<{ crew: number; hairStyle: number; look?: ModelLook; pose: Pose; scale?: number }>(),
  { scale: 2 }
)

const canvasRef = ref<HTMLCanvasElement | null>(null)
const unit = computed(() => cssPerPixel(props.scale))
const { resolvedMotion } = useMotionPreference()
let timer: ReturnType<typeof setInterval> | null = null

function draw(): void {
  const ctx = canvasRef.value?.getContext('2d')
  if (!ctx) return
  const time = resolvedMotion.value === 'reduced' ? 1 : performance.now() / 1000
  drawPortraitV2(
    ctx,
    { crew: props.crew, style: props.hairStyle, look: props.look },
    props.pose,
    time
  )
}

function schedule(): void {
  if (timer) clearInterval(timer)
  timer = null
  draw()
  // 动作本身是逐格的（敲两下、眨一下），一秒六帧够了
  if (resolvedMotion.value !== 'reduced') timer = setInterval(draw, 160)
}

onMounted(schedule)
watch(() => [props.crew, props.hairStyle, props.look, props.pose, resolvedMotion.value], schedule)
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.crew-portrait {
  display: block;
  flex-shrink: 0;
  image-rendering: pixelated;
}
</style>
