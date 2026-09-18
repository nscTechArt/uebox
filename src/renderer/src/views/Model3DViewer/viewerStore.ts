import { defineStore } from 'pinia'
import { ref } from 'vue'

/** 渲染模式。uv 只在有 UV 展开数据时有意义，没有就退回 default */
export type ViewMode = 'default' | 'normal' | 'wireframe' | 'clay' | 'uv'

/** 灯光预设。用户选氛围，不调灯的坐标 —— 调坐标那套是调试面板，不是产品 */
export type LightPreset = 'studio' | 'daylight' | 'night'

export const useModel3DViewerStore = defineStore('model3DViewer', () => {
  const viewMode = ref<ViewMode>('default')
  const autoRotate = ref(false)
  /** 有骨骼动画的模型默认播起来，静态模型这个值没有影响 */
  const autoPlay = ref(true)
  const lightPreset = ref<LightPreset>('studio')
  /** 亮度微调，1 是预设原值 */
  const exposure = ref(1)

  function setViewMode(mode: ViewMode): void {
    viewMode.value = mode
  }

  function setAutoRotate(enabled: boolean): void {
    autoRotate.value = enabled
  }

  function setAutoPlay(enabled: boolean): void {
    autoPlay.value = enabled
  }

  function setLightPreset(preset: LightPreset): void {
    lightPreset.value = preset
  }

  function setExposure(value: number): void {
    exposure.value = Math.min(1.8, Math.max(0.4, value))
  }

  return {
    viewMode,
    autoRotate,
    autoPlay,
    lightPreset,
    exposure,
    setViewMode,
    setAutoRotate,
    setAutoPlay,
    setLightPreset,
    setExposure
  }
})
