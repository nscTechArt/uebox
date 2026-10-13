<template>
  <!--
    团队办公室：把队员画成像素小人，干活的坐在工位上敲键盘、闲着的去冲咖啡浇花。
    动作全由任务板的实时数据推出来（officeInput.ts），模拟在 officeSim.ts，画在 officeDraw.ts。

    只在「团队任务」页签里出现。看不见的时候（切走页签、窗口最小化、滚出视野）不跑动画。
  -->
  <div
    ref="hostRef"
    class="team-office"
    :class="{ 'is-pointing': hoverId !== null || hoverProp !== null }"
  >
    <span ref="probeRef" class="probe" aria-hidden="true" />
    <canvas
      ref="canvasRef"
      class="office-canvas"
      role="img"
      :aria-label="ariaLabel"
      :style="{ width: `${cssWidth}px`, height: `${cssHeight}px` }"
      @pointermove="onPointerMove"
      @pointerleave="onPointerLeave"
      @click="onClick"
    />
    <button
      type="button"
      class="office-style"
      :title="t('assistant.teamBoard.office.styleHint')"
      @click="toggleStyle"
    >
      {{ t(`assistant.teamBoard.office.style.${style}`) }}
    </button>
    <div v-if="card" class="office-card" :style="card.style" role="tooltip">
      <div class="card-head">
        <span class="card-swatch" :style="{ background: card.color }" />
        <span class="card-name">{{ card.name }}</span>
        <span v-if="card.model" class="card-model">{{ card.model }}</span>
      </div>
      <p class="card-status" :class="{ 'is-alert': card.alert }">{{ card.status }}</p>
      <p v-if="card.assignment" class="card-assignment">{{ card.assignment }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { useMotionPreference } from '@renderer/hooks/useMotionPreference'
import {
  teamModelLabel,
  type TeamActivity,
  type TeamModelCandidate,
  type TeamStateView
} from '@core/shared/agentTeam'

import { useTeamLabels } from '../teamBoardLabels'
import { drawOffice } from './officeDraw'
import {
  actorId,
  officeMembers,
  producerMode,
  recentTools,
  stoppedReason,
  teamEvents,
  type RecentTool
} from './officeInput'
import { readPalette, type OfficePalette } from './officePalette'
import { minSceneWidth, OfficeSim, PRODUCER_ID, type Actor } from './officeSim'
import { officeStyle, setOfficeStyle } from './officeStyle'
import { V2_PROFILE } from './v2/artV2'
import { drawOfficeV2, OfficeCat } from './v2/drawV2'
import { loadSprites, type SpriteSet } from './v2/spritesV2'

const props = defineProps<{
  team: TeamStateView
  /** 这条对话正在跑 */
  running?: boolean
  /** 内核 session：制作人调工具的推送按它认 */
  sessionId?: string
  /** 队员最近的动态：在调什么工具 */
  activity?: TeamActivity[]
  modelChoices?: TeamModelCandidate[]
  /** 选中的队员（名字小写），任务和留言按它筛 */
  selected?: string | null
  /** 鼠标停在名册上的哪个人：办公室里把他标出来 */
  highlight?: string | null
}>()
const emit = defineEmits<{ select: [id: string | null] }>()
const { t } = useI18n()
const { toolVerb } = useTeamLabels()
const { resolvedMotion } = useMotionPreference()

const hostRef = ref<HTMLElement | null>(null)
const probeRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const cssWidth = ref(0)
const scale = ref(3)

/**
 * 两种画风：v2 豪华像素（默认）、v1 简约墨线（见 officeStyle.ts）。
 * 两种用的是同一套模拟，只是几何和画法不同；切换时按新几何重摆一遍。
 */
const style = officeStyle
const profile = computed(() => (style.value === 'v2' ? V2_PROFILE : undefined))
const cssHeight = computed(() => Math.round((profile.value ?? sim.profile).sceneH * scale.value))
const hoverId = ref<string | null>(null)
const hoverProp = ref<'plant' | 'machine' | null>(null)
/** 每帧都变的东西不进响应式；卡片要跟着人走，单独一个计数器触发重算 */
const frameTick = ref(0)

function makeSim(): OfficeSim {
  return new OfficeSim(240, {
    reduced: resolvedMotion.value === 'reduced',
    ...(profile.value ? { profile: profile.value } : {})
  })
}
let sim = makeSim()
const cat = new OfficeCat()
const sprites = ref<SpriteSet>({})
let offscreen: HTMLCanvasElement | null = null

function toggleStyle(): void {
  setOfficeStyle(style.value === 'v2' ? 'v1' : 'v2')
  sim = makeSim()
  lastTeam = null
  syncSim(true)
  lastTeam = props.team
  measure()
}
/** 制作人自己最近调的工具（它不走队员动态那条推送） */
const producerTool = ref<RecentTool | null>(null)
const tools = computed(() => {
  const map = recentTools(props.activity ?? [])
  if (producerTool.value) map.set(PRODUCER_ID, producerTool.value)
  return map
})
let palette: OfficePalette | null = null
let lastTeam: TeamStateView | null = null

// ── 数据 → 模拟 ─────────────────────────────────────────────────────────

function syncSim(fresh = false): void {
  const team = props.team
  sim.sync(officeMembers(team, tools.value), producerMode(team, !!props.running), { fresh })
}

watch(
  () => [props.team, props.running, tools.value] as const,
  ([team]) => {
    const fresh = lastTeam === null
    syncSim(fresh)
    for (const event of teamEvents(lastTeam, team)) {
      if (event.kind === 'mail') sim.mail(event.from, event.to)
      else if (event.kind === 'done') sim.done(event.id)
      else if (event.kind === 'blocked') sim.blocked(event.id)
      else sim.verdict(event.result)
    }
    lastTeam = team
  },
  { immediate: true }
)

watch(resolvedMotion, (motion) => {
  sim.reduced = motion === 'reduced'
})

/** 制作人自己调工具：悬停卡片上写它在干嘛 */
function onToolCall(...args: unknown[]): void {
  const data = args[0] as { sessionId?: string; toolName?: string } | undefined
  if (!data || !props.sessionId || data.sessionId !== props.sessionId || !data.toolName) return
  producerTool.value = { tool: data.toolName, at: Date.now() }
}

// ── 尺寸、调色板 ────────────────────────────────────────────────────────

let resizeObserver: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null

function measure(): void {
  const host = hostRef.value
  if (!host) return
  const available = Math.floor(host.clientWidth)
  if (available <= 0) return
  const members = props.team.members.length
  const minWidth = minSceneWidth(members, sim.profile)
  let width: number
  if (style.value === 'v2') {
    // 豪华版细节多，放 2 倍；面板窄了就按比例缩（不再是整数倍，但不至于挤掉人）
    scale.value = available >= minWidth * 2 ? 2 : Math.max(1, available / minWidth)
    width = scale.value === 2 ? Math.max(minWidth, Math.floor(available / 2)) : minWidth
  } else {
    // 放得下就放大到 3 倍，窄了退到 2 倍；场景宽度跟着面板走
    scale.value = available >= minWidth * 3 ? 3 : 2
    width = Math.max(minWidth, Math.floor(available / scale.value))
  }
  cssWidth.value = Math.min(available, Math.round(width * scale.value))
  if (width !== sim.layout.width) sim.resize(width)
  const canvas = canvasRef.value
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(cssWidth.value * dpr)
  canvas.height = Math.round(sim.profile.sceneH * scale.value * dpr)
  render()
}

function refreshPalette(): void {
  if (probeRef.value) palette = readPalette(probeRef.value)
  render()
}

// ── 动画循环 ────────────────────────────────────────────────────────────

let frame = 0
let idleFrames = 0
let lastTime = 0
let onScreen = true
let reducedTimer = 0

function render(): void {
  const canvas = canvasRef.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  if (style.value === 'v2') {
    renderV2(canvas, ctx)
    return
  }
  if (!palette) return
  const k = canvas.width / sim.layout.width
  ctx.setTransform(k, 0, 0, k, 0, 0)
  ctx.imageSmoothingEnabled = false
  drawOffice(ctx, sim, palette, {
    board: props.team.board.map((task) => task.status),
    hover: hoverId.value ?? props.highlight ?? null,
    selected: props.selected ?? null,
    now: new Date()
  })
}

/** 豪华版先按 1 倍画在离屏画布上，再整张放大贴过去：缩放比不是整数时每个像素也一样大小 */
function renderV2(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
  const { width, height } = sim.layout
  offscreen ??= document.createElement('canvas')
  if (offscreen.width !== width || offscreen.height !== height) {
    offscreen.width = width
    offscreen.height = height
  }
  const off = offscreen.getContext('2d')
  if (!off) return
  off.imageSmoothingEnabled = false
  drawOfficeV2(off, sim, {
    board: props.team.board.map((task) => task.status),
    hover: hoverId.value ?? props.highlight ?? null,
    selected: props.selected ?? null,
    now: new Date(),
    sprites: sprites.value,
    cat,
    tools: new Map([...tools.value].map(([id, recent]) => [id, recent.tool]))
  })
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(offscreen, 0, 0, canvas.width, canvas.height)
}

function tick(now: number): void {
  frame = 0
  const dt = lastTime ? (now - lastTime) / 1000 : 0
  lastTime = now
  sim.step(dt)
  render()
  // 悬停卡片要跟着人走，每帧都更新；没人悬停时读屏文字半秒更新一次就够
  if (hoverId.value || ++idleFrames >= 30) {
    idleFrames = 0
    frameTick.value++
  }
  schedule()
}

function schedule(): void {
  if (frame || reducedTimer) return
  if (!onScreen || document.hidden) {
    lastTime = 0
    return
  }
  if (sim.reduced) {
    // 减少动效：不放动画，几秒刷一次让钟和状态跟上
    reducedTimer = window.setTimeout(() => {
      reducedTimer = 0
      tick(performance.now())
    }, 2000)
    return
  }
  frame = requestAnimationFrame(tick)
}

let visibility: IntersectionObserver | null = null
const onVisibility = (): void => schedule()

// ── 指针 ────────────────────────────────────────────────────────────────

function scenePoint(event: MouseEvent): { x: number; y: number } | null {
  const canvas = canvasRef.value
  if (!canvas) return null
  const box = canvas.getBoundingClientRect()
  if (box.width <= 0) return null
  const k = sim.layout.width / box.width
  return { x: (event.clientX - box.left) * k, y: (event.clientY - box.top) * k }
}

function onPointerMove(event: PointerEvent): void {
  const point = scenePoint(event)
  if (!point) return
  const actor = sim.hit(point.x, point.y)
  hoverId.value = actor?.id ?? null
  hoverProp.value = actor
    ? null
    : (sim.hitProp(point.x, point.y) ??
      (style.value === 'v2' && cat.hit(sim, point.x, point.y) ? 'plant' : null))
}

function onPointerLeave(): void {
  hoverId.value = null
  hoverProp.value = null
}

function onClick(event: MouseEvent): void {
  const point = scenePoint(event)
  if (!point) return
  const actor = sim.hit(point.x, point.y)
  if (actor) {
    sim.poke(actor.id)
    if (!actor.producer) emit('select', props.selected === actor.id ? null : actor.id)
    return
  }
  const prop = sim.hitProp(point.x, point.y)
  if (prop) sim.pokeProp(prop)
  else if (style.value === 'v2' && cat.hit(sim, point.x, point.y)) cat.poke(sim)
  else if (props.selected) emit('select', null)
}

// ── 悬停卡片 ────────────────────────────────────────────────────────────

const ERRAND_KEYS = new Set([
  'coffee',
  'water',
  'plant',
  'window',
  'sofa',
  'desk',
  'stretch',
  'board',
  'pace'
])

function displayName(actor: Actor): string {
  return actor.producer ? t('assistant.teamBoard.producer') : actor.name
}

function statusOf(actor: Actor): { text: string; alert: boolean } {
  const mode = actor.mode
  const office = 'assistant.teamBoard.office'
  const recent = tools.value.get(actor.id)
  if (mode.kind === 'work') {
    // 和面板名册说同一句话：「正在查看目录」，不把工具名端给用户
    if (mode.tool === 'think' || !recent?.tool)
      return { text: t(`${office}.status.think`), alert: false }
    return {
      text: t('assistant.teamBoard.statusLine.tool', { verb: toolVerb(recent.tool) }),
      alert: false
    }
  }
  if (mode.kind === 'wait') return { text: t(`${office}.status.wait`), alert: false }
  if (mode.kind === 'out') {
    const reason = stoppedReason(props.team, actor.name) ?? ''
    return { text: t(`${office}.status.out`, { reason }), alert: true }
  }
  if (mode.kind === 'board') {
    return {
      text: recent?.tool
        ? `${t(`${office}.status.board`)} · ${toolVerb(recent.tool)}`
        : t(`${office}.status.board`),
      alert: false
    }
  }
  if (mode.kind === 'awaiting') {
    const target = sim.actors.get(mode.on)
    return { text: t(`${office}.status.awaiting`, { name: target?.name ?? mode.on }), alert: false }
  }
  const errand = actor.errand
  if (errand?.kind === 'chat') {
    const partner = errand.partner ? sim.actors.get(errand.partner) : undefined
    return {
      text: t(`${office}.idle.chat`, { name: partner ? displayName(partner) : '' }),
      alert: false
    }
  }
  if (errand?.kind === 'peek') {
    const target = [...sim.actors.values()].find((a) => errand.spot === `peek:${a.id}`)
    return { text: t(`${office}.idle.peek`, { name: target?.name ?? '' }), alert: false }
  }
  if (errand && ERRAND_KEYS.has(errand.kind))
    return { text: t(`${office}.idle.${errand.kind}`), alert: false }
  return { text: t(`${office}.idle.idle`), alert: false }
}

const card = computed(() => {
  void frameTick.value
  const id = hoverId.value
  const actor = id ? sim.actors.get(id) : undefined
  const host = hostRef.value
  const canvas = canvasRef.value
  if (!actor || !host || !canvas) return null
  const member = props.team.members.find((m) => actorId(m.name) === actor.id)
  const assignment = props.team.live?.assignments.find((a) => actorId(a.member) === actor.id)?.text
  const status = statusOf(actor)
  const head = sim.headOf(actor)
  const k = cssWidth.value / sim.layout.width
  const canvasLeft = canvas.offsetLeft
  const x = canvasLeft + head.x * k
  const flip = x > host.clientWidth / 2
  return {
    name: displayName(actor),
    model: member?.model ? teamModelLabel(props.modelChoices ?? [], member.model) : '',
    status: status.text,
    alert: status.alert,
    assignment: assignment ?? '',
    color: palette
      ? actor.crew < 0
        ? palette.accent
        : palette.crew[actor.crew % palette.crew.length]
      : undefined,
    style: {
      top: `${Math.max(0, head.y * k - 8)}px`,
      ...(flip ? { right: `${host.clientWidth - x + 14}px` } : { left: `${x + 14}px` })
    }
  }
})

const ariaLabel = computed(() => {
  void frameTick.value
  const lines = [...sim.actors.values()].map(
    (actor) => `${displayName(actor)}：${statusOf(actor).text}`
  )
  return t('assistant.teamBoard.office.aria', { summary: lines.join('；') })
})

// ── 生命周期 ────────────────────────────────────────────────────────────

let toolCallHandler: unknown = null

onMounted(() => {
  void loadSprites().then((set) => {
    sprites.value = set
    render()
  })
  refreshPalette()
  measure()
  resizeObserver = new ResizeObserver(measure)
  if (hostRef.value) resizeObserver.observe(hostRef.value)
  // 换主题、换自定义配色：根元素的属性或内联样式会变
  themeObserver = new MutationObserver(refreshPalette)
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'style', 'class']
  })
  visibility = new IntersectionObserver((entries) => {
    onScreen = entries.some((entry) => entry.isIntersecting)
    schedule()
  })
  if (hostRef.value) visibility.observe(hostRef.value)
  document.addEventListener('visibilitychange', onVisibility)
  toolCallHandler = window.api.on('agent-v3:tool-call', onToolCall)
  schedule()
})

onBeforeUnmount(() => {
  if (frame) cancelAnimationFrame(frame)
  if (reducedTimer) clearTimeout(reducedTimer)
  resizeObserver?.disconnect()
  themeObserver?.disconnect()
  visibility?.disconnect()
  document.removeEventListener('visibilitychange', onVisibility)
  // preload 的 on() 返回包过一层的处理器，off() 要传回这一个
  if (toolCallHandler) window.api.off('agent-v3:tool-call', toolCallHandler as never)
})

watch(
  () => props.team.members.length,
  () => measure()
)
watch(
  () => [hoverId.value, props.selected, props.highlight],
  () => render()
)

defineExpose({ sim })
</script>

<style scoped>
.team-office {
  position: relative;
  /* 悬停卡片可能比办公室还高，不能裁：它要盖到下面的内容上 */
  z-index: 1;
  display: flex;
  justify-content: center;
  border-radius: var(--radius-md);
  background: var(--color-bg-sunken);
}

.team-office.is-pointing .office-canvas {
  cursor: pointer;
}

.probe {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
}

.office-canvas {
  display: block;
  border-radius: var(--radius-md);
  image-rendering: pixelated;
}

/* 画风切换：右上角一个小角标，悬停办公室时才显出来 */
.office-style {
  position: absolute;
  top: var(--space-1);
  right: var(--space-1);
  z-index: 1;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-bg-raised);
  color: var(--color-text-secondary);
  font-family: inherit;
  font-size: var(--font-size-xs);
  line-height: 18px;
  opacity: 0;
  cursor: pointer;
  transition: opacity 140ms ease;
}

.team-office:hover .office-style,
.office-style:focus-visible {
  opacity: 1;
}

.office-style:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 1px;
}

.office-card {
  position: absolute;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: 240px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-menu);
  font-size: var(--font-size-xs);
  line-height: var(--line-height-normal);
  pointer-events: none;
}

.card-head {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.card-swatch {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-xs);
}

.card-name {
  color: var(--color-text-primary);
  font-weight: var(--font-weight-semibold);
  white-space: nowrap;
}

.card-model {
  min-width: 0;
  color: var(--color-text-muted);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.card-status {
  margin: 0;
  color: var(--color-text-secondary);
}

.card-status.is-alert {
  color: var(--color-danger-text);
}

.card-assignment {
  display: -webkit-box;
  margin: 0;
  color: var(--color-text-muted);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
</style>
