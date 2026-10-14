<template>
  <canvas
    ref="canvasRef"
    class="pixel-label"
    role="img"
    :aria-label="text"
    :style="{ width: `${box.w * unit}px`, height: `${box.h * unit}px` }"
  />
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'

import { cssPerPixel } from './pixelScale'

/**
 * 点阵标题：任意文字（中文也行），用系统字体按小字号画在小画布上，
 * 再把每个像素二值化（要么实、要么空），整数倍放大 —— 出来就是老游戏的点阵字。
 *
 * 不打包点阵字库：中文字库动辄几 MB，这里只给标题、印章这种几个字的地方用，
 * 正文照旧是系统字体（点阵正文读起来累）。
 *
 * 宋体在 12px 上本身就是点阵（Windows 自带的内嵌位图），放在最前；
 * 别的系统落到黑体上，二值化之后也是方块字，只是笔画粗一点。
 */
const props = withDefaults(
  defineProps<{
    text: string
    color: string
    /** 投影色。给了就在右下垫一格 */
    shadow?: string
    /** 字号（画布像素） */
    size?: number
    scale?: number
    bold?: boolean
  }>(),
  { shadow: undefined, size: 12, scale: 2, bold: false }
)

const FONT_STACK = `"SimSun", "NSimSun", "Songti SC", "PingFang SC", "Microsoft YaHei", sans-serif`
/** 灰度过这个值算实。低了笔画糊成一团，高了细横会断 */
const THRESHOLD = 120

const canvasRef = ref<HTMLCanvasElement | null>(null)
const unit = computed(() => cssPerPixel(props.scale))
const box = reactive({ w: 1, h: 1 })

function draw(): void {
  const canvas = canvasRef.value
  const ctx = canvas?.getContext('2d', { willReadFrequently: true })
  if (!canvas || !ctx) return
  const font = `${props.bold ? 'bold ' : ''}${props.size}px ${FONT_STACK}`
  ctx.font = font
  const pad = props.shadow ? 1 : 0
  const w = Math.max(1, Math.ceil(ctx.measureText(props.text).width) + pad)
  const h = props.size + 2 + pad
  canvas.width = w
  canvas.height = h
  box.w = w
  box.h = h

  // 先用白字画一遍，拿它的覆盖度当模板
  ctx.font = font
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#fff'
  ctx.fillText(props.text, 0, 1)
  const mask = ctx.getImageData(0, 0, w, h)
  ctx.clearRect(0, 0, w, h)

  const out = ctx.createImageData(w, h)
  const paint = (hex: string, dx: number, dy: number): void => {
    const [r, g, b] = rgb(hex)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask.data[(y * w + x) * 4 + 3]! < THRESHOLD) continue
        const tx = x + dx
        const ty = y + dy
        if (tx >= w || ty >= h) continue
        const i = (ty * w + tx) * 4
        out.data[i] = r
        out.data[i + 1] = g
        out.data[i + 2] = b
        out.data[i + 3] = 255
      }
    }
  }
  if (props.shadow) paint(props.shadow, 1, 1)
  paint(props.color, 0, 0)
  ctx.putImageData(out, 0, 0)
}

function rgb(hex: string): [number, number, number] {
  const v = hex.replace('#', '')
  const full = v.length === 3 ? [...v].map((c) => c + c).join('') : v
  const n = parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

onMounted(() => {
  draw()
  // 字体可能还没就绪（第一次打开面板时），就绪后再画一遍
  void document.fonts?.ready.then(draw)
})
watch(() => [props.text, props.color, props.shadow, props.size, props.bold], draw)
</script>

<style scoped>
.pixel-label {
  display: inline-block;
  flex-shrink: 0;
  vertical-align: middle;
  image-rendering: pixelated;
}
</style>
