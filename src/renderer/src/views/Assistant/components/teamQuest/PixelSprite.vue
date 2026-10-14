<template>
  <canvas
    ref="canvasRef"
    class="pixel-sprite"
    :style="{ width: `${width * unit}px`, height: `${height * unit}px` }"
    aria-hidden="true"
  />
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import type { PixelArt } from './pixelArt'
import { cssPerPixel } from './pixelScale'

/** 一张小像素图：按格画在原尺寸画布上，CSS 放大，`pixelated` 保持方块 */
const props = withDefaults(defineProps<{ art: PixelArt; scale?: number }>(), { scale: 2 })

const canvasRef = ref<HTMLCanvasElement | null>(null)
const unit = computed(() => cssPerPixel(props.scale))
const width = computed(() => Math.max(...props.art.rows.map((row) => row.length)))
const height = computed(() => props.art.rows.length)

function draw(): void {
  const canvas = canvasRef.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  canvas.width = width.value
  canvas.height = height.value
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  props.art.rows.forEach((row, y) => {
    ;[...row].forEach((ch, x) => {
      const color = props.art.palette[ch]
      if (!color) return
      ctx.fillStyle = color
      ctx.fillRect(x, y, 1, 1)
    })
  })
}

onMounted(draw)
watch(() => props.art, draw)
</script>

<style scoped>
.pixel-sprite {
  display: block;
  flex-shrink: 0;
  image-rendering: pixelated;
}
</style>
