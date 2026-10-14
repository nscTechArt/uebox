<template>
  <canvas
    ref="canvasRef"
    class="pixel-text"
    role="img"
    :aria-label="text"
    :style="{ width: `${width * unit}px`, height: `${HEIGHT * unit}px` }"
  />
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

import { FONT } from '../teamOffice/v2/artV2'
import { cssPerPixel } from './pixelScale'

/**
 * 一行 3×5 点阵字：只收数字、几个字母和符号（见 artV2 的 FONT），用于计数、进度、NEW。
 * 中文不走这里 —— 点阵中文要打包字库，界面上的中文照旧用系统字体。
 * `shadow` 给了就在右下角垫一层，像老游戏的投影字。
 */
const props = withDefaults(
  defineProps<{ text: string; color: string; shadow?: string; scale?: number }>(),
  { scale: 2, shadow: undefined }
)

const HEIGHT = 6
const canvasRef = ref<HTMLCanvasElement | null>(null)
const unit = computed(() => cssPerPixel(props.scale))
const glyphs = computed(() => [...props.text.toUpperCase()])
const width = computed(() => Math.max(1, glyphs.value.length * 4))

function draw(): void {
  const canvas = canvasRef.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  canvas.width = width.value
  canvas.height = HEIGHT
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const paint = (color: string, dx: number, dy: number): void => {
    ctx.fillStyle = color
    glyphs.value.forEach((ch, i) => {
      const rows = FONT[ch] ?? FONT[' ']!
      rows.forEach((bits, y) => {
        for (let x = 0; x < 3; x++) {
          if (bits & (0b100 >> x)) ctx.fillRect(i * 4 + x + dx, y + dy, 1, 1)
        }
      })
    })
  }
  if (props.shadow) paint(props.shadow, 1, 1)
  paint(props.color, 0, 0)
}

onMounted(draw)
watch(() => [props.text, props.color, props.shadow], draw)
</script>

<style scoped>
.pixel-text {
  display: inline-block;
  flex-shrink: 0;
  vertical-align: middle;
  image-rendering: pixelated;
}
</style>
