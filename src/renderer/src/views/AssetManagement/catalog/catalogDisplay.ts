/**
 * 服务端资产库条目的显示辅助：类图标（没有预览图时画它，不发请求 —— 设计 2.3 "缺图"一条）、
 * 大小和时间的格式化。
 */
import type { Component } from 'vue'
import {
  PhCube,
  PhPersonSimple,
  PhImage,
  PhPalette,
  PhMapTrifold,
  PhFlowArrow,
  PhSpeakerHigh,
  PhFilmStrip,
  PhSparkle,
  PhFile,
  PhBone,
  PhTextT
} from '@phosphor-icons/vue'
import { formatFileSize, getAssetTypeColor } from '@renderer/utils/tool'

const ICONS: Array<[RegExp, Component]> = [
  [/^StaticMesh/, PhCube],
  [/^Skeleton$/, PhBone],
  [/^(SkeletalMesh|PhysicsAsset)/, PhPersonSimple],
  [/^(Texture|TextureCube|TextureRenderTarget)/, PhImage],
  [/^Material/, PhPalette],
  [/^(World|Level)/, PhMapTrifold],
  [/Blueprint|^WidgetBlueprint|^AnimBlueprint/, PhFlowArrow],
  [/^(Sound|MetaSound)/, PhSpeakerHigh],
  [/^(Anim|BlendSpace|LevelSequence)/, PhFilmStrip],
  [/^(Niagara|ParticleSystem)/, PhSparkle],
  [/^(Font|DataTable|StringTable)/, PhTextT]
]

export function classIcon(className: string | null | undefined, ext?: string | null): Component {
  if (!className && ext === '.umap') return PhMapTrifold
  if (!className) return PhFile
  for (const [pattern, icon] of ICONS) if (pattern.test(className)) return icon
  return PhFile
}

export function classColor(className: string | null | undefined, name?: string): string {
  return getAssetTypeColor(className ?? undefined, name)
}

export function formatSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—'
  return formatFileSize(bytes)
}

export function formatTime(ms: number | null | undefined, locale: string): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
  return new Date(ms).toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** "Content/Props/Chair.uasset" → "Chair"（网格里显示用） */
export function displayName(name: string): string {
  return name.replace(/\.(uasset|umap)$/i, '')
}

/** 64 位指纹按两位一组显示，只显示头尾 */
export function shortFingerprint(fingerprint: string | null | undefined): string {
  if (!fingerprint) return ''
  const pairs = fingerprint.toUpperCase().match(/.{2}/g) ?? []
  return pairs.length > 8
    ? `${pairs.slice(0, 4).join(':')}…${pairs.slice(-4).join(':')}`
    : pairs.join(':')
}
