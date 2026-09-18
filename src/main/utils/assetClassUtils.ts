/**
 * 资产类别工具函数
 * 提供 Unreal Engine 资产类名的中文翻译和颜色映射
 */

/**
 * 类名到中文名的映射配置
 * 顺序很重要：更具体的匹配应该放在前面
 */
const CLASS_MAPPING: Array<{ test: (s: string) => boolean; name: string }> = [
  // Actor 类型（放在前面优先匹配，因为 StaticMeshActor 包含 StaticMesh）
  { test: (x) => x === 'StaticMeshActor', name: '静态网格体Actor' },
  { test: (x) => x.includes('Actor'), name: 'Actor' },

  // Volume 类型
  { test: (x) => x === 'BlockingVolume', name: '阻挡体积' },
  { test: (x) => x === 'TriggerVolume', name: '触发体积' },
  { test: (x) => x === 'NavMeshBoundsVolume', name: '导航网格边界' },
  { test: (x) => x === 'LightmassImportanceVolume', name: 'Lightmass重要性体积' },
  { test: (x) => x === 'PostProcessVolume', name: '后处理体积' },
  { test: (x) => x === 'CameraBlockingVolume', name: '相机阻挡体积' },
  { test: (x) => x === 'KillZVolume', name: '死亡区域' },
  { test: (x) => x === 'PainCausingVolume', name: '伤害区域' },
  { test: (x) => x === 'PhysicsVolume', name: '物理体积' },
  { test: (x) => x.includes('Volume'), name: '体积' },

  // 网格体类型
  { test: (x) => x.includes('StaticMesh'), name: '静态网格体' },
  { test: (x) => x.includes('SkeletalMesh'), name: '骨骼网格体' },

  // 纹理类型
  { test: (x) => x === 'TextureCube', name: '立方体纹理' },
  { test: (x) => x === 'TextureRenderTarget2D', name: '渲染目标2D' },
  { test: (x) => x === 'TextureRenderTargetCube', name: '立方体渲染目标' },
  { test: (x) => x === 'VolumeTexture', name: '体积纹理' },
  { test: (x) => x === 'MediaTexture', name: '媒体纹理' },
  { test: (x) => x.includes('Texture2D'), name: '纹理2D' },
  { test: (x) => x.includes('Texture'), name: '纹理' },

  // 材质类型
  { test: (x) => x.includes('MaterialParameterCollection'), name: '材质参数集' },
  { test: (x) => x.includes('MaterialFunction'), name: '材质函数' },
  { test: (x) => x.includes('MaterialInstanceConstant'), name: '材质实例' },
  { test: (x) => x.includes('MaterialInstanceDynamic'), name: '动态材质实例' },
  { test: (x) => x === 'Material', name: '主材质' },
  { test: (x) => x.includes('Material'), name: '材质' },

  // 骨骼和动画
  { test: (x) => x === 'Skeleton', name: '骨骼' },
  { test: (x) => x.includes('AnimSequence'), name: '动画序列' },
  { test: (x) => x.includes('AnimMontage'), name: '动画蒙太奇' },
  { test: (x) => x.includes('AnimBlueprint'), name: '动画蓝图' },
  { test: (x) => x === 'BlendSpace', name: '混合空间' },
  { test: (x) => x.includes('BlendSpace1D'), name: '混合空间1D' },
  { test: (x) => x.includes('BlendSpace'), name: '混合空间' },
  { test: (x) => x.includes('AnimNotify'), name: '动画通知' },
  { test: (x) => x.includes('AnimCurve'), name: '动画曲线' },
  { test: (x) => x.includes('AimOffset'), name: '瞄准偏移' },
  { test: (x) => x.includes('Anim'), name: '动画' },

  // IK 和重定向
  { test: (x) => x === 'IKRetargeter', name: 'IK重定向器' },
  { test: (x) => x === 'IKRigDefinition', name: 'IK骨架定义' },
  { test: (x) => x.includes('IKRig'), name: 'IK骨架' },

  // 蓝图类型
  { test: (x) => x.includes('WidgetBlueprint'), name: '控件蓝图' },
  { test: (x) => x.includes('BlueprintFunctionLibrary'), name: '蓝图函数库' },
  { test: (x) => x.includes('BlueprintFunction'), name: '蓝图函数' },
  { test: (x) => x.includes('EditorUtilityWidgetBlueprint'), name: '编辑器控件蓝图' },
  // 注意：关卡（带蓝图）已合并到"关卡"类型
  { test: (x) => x.includes('Blueprint'), name: '蓝图' },

  // 关卡和序列
  { test: (x) => x.includes('World'), name: '关卡' },
  { test: (x) => x.includes('LevelSequence'), name: '关卡序列' },

  // 特效
  { test: (x) => x.includes('NiagaraSystem'), name: 'Niagara系统' },
  { test: (x) => x.includes('NiagaraEmitter'), name: 'Niagara发射器' },
  { test: (x) => x.includes('Niagara'), name: 'Niagara特效' },
  { test: (x) => x.includes('ParticleSystem'), name: '粒子系统' },

  // 输入系统 (Enhanced Input)
  { test: (x) => x === 'InputAction', name: '输入动作' },
  { test: (x) => x === 'InputMappingContext', name: '输入映射上下文' },
  { test: (x) => x.includes('InputAction'), name: '输入动作' },

  // 曲线类型
  { test: (x) => x === 'CurveLinearColor', name: '线性颜色曲线' },
  { test: (x) => x === 'CurveLinearColorAtlas', name: '线性颜色曲线图集' },
  { test: (x) => x.includes('CurveFloat'), name: '浮点曲线' },
  { test: (x) => x.includes('CurveVector'), name: '向量曲线' },
  { test: (x) => x.includes('Curve'), name: '曲线' },

  // 地形相关
  { test: (x) => x === 'LandscapeLayerInfoObject', name: '地形图层信息' },
  { test: (x) => x === 'LandscapeGrassType', name: '地形草地类型' },
  { test: (x) => x.includes('Landscape'), name: '地形' },

  // 物理相关
  { test: (x) => x.includes('PhysicsAsset'), name: '物理资产' },
  { test: (x) => x.includes('PhysicalMaterial'), name: '物理材质' },

  // Pose 和控制绑定
  { test: (x) => x.includes('PoseAsset'), name: 'Pose资产' },
  { test: (x) => x.includes('ControlRig'), name: '控制绑定' },

  // 音频
  { test: (x) => x.includes('SoundWave'), name: '音波' },
  { test: (x) => x.includes('SoundCue'), name: '音效' },
  { test: (x) => x.includes('SoundClass'), name: '音效类' },
  { test: (x) => x.includes('SoundMix'), name: '音效混合' },
  { test: (x) => x.includes('SoundAttenuation'), name: '音效衰减' },
  { test: (x) => x.includes('MetaSound'), name: 'MetaSound' },

  // 数据资产
  { test: (x) => x.includes('DataTable'), name: '数据表' },
  { test: (x) => x.includes('DataAsset'), name: '数据资产' },
  { test: (x) => x.includes('PrimaryDataAsset'), name: '主数据资产' },

  // 构建数据
  { test: (x) => x === 'MapBuildDataRegistry', name: '地图构建数据' },

  // 其他常见类型
  { test: (x) => x.includes('ObjectRedirector'), name: '资产重定向' },
  { test: (x) => x.includes('BlueprintType'), name: '枚举' },
  { test: (x) => x.includes('UserDefinedStruct'), name: '自定义结构体' },
  { test: (x) => x.includes('UserDefinedEnum'), name: '自定义枚举' },
  { test: (x) => x.includes('Font'), name: '字体' },
  { test: (x) => x.includes('FontFace'), name: '字体面' },

  // Foliage
  { test: (x) => x.includes('FoliageType'), name: '植被类型' },

  // Behavior Tree / AI
  { test: (x) => x.includes('BehaviorTree'), name: '行为树' },
  { test: (x) => x.includes('BlackboardData'), name: '黑板数据' },
  { test: (x) => x.includes('AIController'), name: 'AI控制器' },
  { test: (x) => x.includes('EnvQuery'), name: '环境查询' },

  // Media
  { test: (x) => x.includes('MediaPlayer'), name: '媒体播放器' },
  { test: (x) => x.includes('MediaSource'), name: '媒体源' },
  { test: (x) => x.includes('FileMediaSource'), name: '文件媒体源' },

  // Gameplay
  { test: (x) => x.includes('GameplayAbility'), name: '游戏能力' },
  { test: (x) => x.includes('GameplayEffect'), name: '游戏效果' },
  { test: (x) => x.includes('GameplayTag'), name: '游戏标签' },

  // 序列与渲染
  { test: (x) => x.includes('MoviePipelineMasterConfig'), name: '渲染序列配置' },
  { test: (x) => x.includes('MoviePipeline'), name: '渲染序列' },

  // 几何体
  { test: (x) => x.includes('GeometryCollection'), name: '几何体集合' },

  // 对话系统
  { test: (x) => x.includes('DialogueVoice'), name: '对话语音' },
  { test: (x) => x.includes('DialogueWave'), name: '对话波形' },

  // 字体相关
  { test: (x) => x.includes('FontFace'), name: '字体面' },
  { test: (x) => x.includes('Font'), name: '字体' },

  // 物理材质
  { test: (x) => x.includes('PhysicalMaterial'), name: '物理材质' },

  // 混合空间 (单独分类)
  { test: (x) => x.includes('BlendSpace1D'), name: '混合空间1D' },
  { test: (x) => x.includes('BlendSpace'), name: '混合空间' }
]

/**
 * 获取资产类名的中文翻译
 * @param className Unreal Engine 的类名
 * @returns 中文名称，如果没有匹配则返回原始类名
 */
export function getAssetClassNameCn(className?: string): string {
  const s = String(className || '')
  try {
    if (!s) return '资产'
    const matched = CLASS_MAPPING.find((item) => item.test(s))
    return matched ? matched.name : s
  } catch {
    return '资产'
  }
}

/**
 * 获取资产类别的颜色
 * @param className Unreal Engine 的类名
 * @returns 颜色值（CSS 格式）
 */
export function getAssetClassColor(className?: string): string {
  const s = String(className || '')
  if (!s) return '#888888'

  // 网格体
  if (s.includes('StaticMesh')) return 'rgba(0,255,255,0.8)'
  if (s.includes('SkeletalMesh')) return '#f1a3f1'

  // 关卡和序列
  if (s.includes('World') || s.includes('LevelSequence')) return '#ff7e00'

  // 纹理
  if (s.includes('Texture')) return '#c04040'

  // 骨骼
  if (s === 'Skeleton') return '#6edcea'

  // 材质系统
  if (s === 'Material') return '#497C6E'
  if (s.includes('MaterialInstanceConstant')) return '#5E8C7A'
  if (s.includes('MaterialParameterCollection')) return '#6B9C8A'
  if (s.includes('MaterialFunction')) return '#7AAB9A'
  if (s.includes('Material')) return '#88BBA5'

  // 蓝图
  if (s === 'Blueprint') return '#3651d3'
  if (s.includes('WidgetBlueprint')) return s.includes('EditorUtility') ? '#5B75E3' : '#4A63DB'
  if (s.includes('BlueprintFunction')) return '#4668D9'
  if (s.includes('Blueprint')) return '#3651d3'

  // 特效
  if (s.includes('NiagaraSystem')) return '#5288c7'
  if (s.includes('Niagara')) return '#5288c7'
  if (s.includes('ParticleSystem')) return '#5288c7'

  // 动画
  if (s.includes('AnimSequence')) return '#3abe45'
  if (s.includes('BlendSpace')) return '#3abe45'
  if (s.includes('AnimBlueprint')) return '#e47a4c'
  if (s.includes('Anim')) return '#CC5B8F'

  // IK 和重定向
  if (s.includes('IKRetargeter') || s.includes('IKRig')) return '#9b59b6'

  // 输入系统
  if (s.includes('InputAction') || s.includes('InputMappingContext')) return '#e74c3c'

  // 曲线
  if (s.includes('Curve')) return '#f39c12'

  // 地形
  if (s.includes('Landscape')) return '#27ae60'

  // 物理
  if (s.includes('PhysicsAsset') || s.includes('PhysicalMaterial')) return '#1abc9c'

  // 音频
  if (s.includes('Sound') || s.includes('MetaSound')) return '#9b59b6'

  // 数据
  if (s.includes('DataTable') || s.includes('DataAsset')) return '#3498db'

  // AI
  if (s.includes('BehaviorTree') || s.includes('Blackboard')) return '#e67e22'

  return '#888888'
}
