<script setup lang="ts">
/**
 * ModelViewer —— 3D 模型查看器（直接用 three.js）
 *
 * 2026-09-14 重写。原来这里套的是 vue-3d-loader：它把 three r143 整份打进自己的包，
 * 我们又单独 import 了一份 three —— 两份引擎同屏，而且够不着渲染器本体，于是
 * 环境光照、色调映射、阴影、设备像素比全都没法设，模型出来就是一块"灰塑料"。
 * 还得靠改写 Object.defineProperty 来兜它内部的崩溃。现在直连 three，画面归我们管。
 *
 * 画面基线（动之前先想清楚为什么）：
 * - 环境光照（RoomEnvironment + PMREM）：PBR 材质没有它就没有高光层次，怎么打灯都是塑料
 * - ACES 色调映射：高光不过曝、暗部不死黑，这是"贵"的第一来源
 * - 接触阴影：模型和地面有关系，才不像贴在屏幕上的纸片
 * - 统一取景：归一化到固定大小 + 固定 3/4 机位，每个模型进来都一样稳
 * - 设备像素比交给 three：不要再手动设 canvas.width，那等于把画面打回 1x
 */
import { ref, shallowRef, computed, watch, onMounted, onUnmounted } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { isHttpUrl, toAssetFileUrl } from '@renderer/utils/assetAccess'
import AppSpin from '@renderer/components/AppSpin.vue'
import { PhWarningCircle, PhCube } from '@phosphor-icons/vue'

/** 灯光预设：用户只选氛围，不调灯的 XYZ */
export type LightPreset = 'studio' | 'daylight' | 'night'
/** 可视化模式 */
export type ViewMode = 'default' | 'normal' | 'wireframe' | 'clay' | 'uv'

const props = defineProps<{
  file?: File | null
  filePath?: string | null
  fileUrl?: string | null
  /** 灯光预设，默认影棚 */
  lightPreset?: LightPreset
  /** 亮度微调，1 为预设原值，范围建议 0.4 ~ 1.8 */
  exposure?: number
  viewMode?: ViewMode
  autoRotate?: boolean
  autoPlay?: boolean
}>()

const emit = defineEmits<{
  modelStats: [
    stats: {
      vertices?: number
      faces?: number
      materials?: number
      meshCount?: number
      textureCount?: number
      /** 包围盒尺寸，单位是模型自己的单位（归一化之前） */
      boundingBox?: { x: number; y: number; z: number }
      hasAnimations?: boolean
      animationCount?: number
    }
  ]
  /** 截图，Base64 JPEG */
  snapshot: [base64: string]
  /** 模型进场景了。缩略图生成、气泡预览都靠这个信号接着干活 */
  load: []
  /** 加载失败，带上原因 */
  error: [message: string]
}>()

// ============ 取景常量 ============
/** 模型归一化后的最大边长（世界单位）。所有模型都缩到这个尺寸，取景才稳定 */
const TARGET_SIZE = 2
/** 视场角。32° 比默认的 50° 透视畸变小，更像产品照 */
const CAMERA_FOV = 32
/** 默认机位：水平 32°、仰角 16° 的 3/4 视角 */
const CAMERA_AZIMUTH = THREE.MathUtils.degToRad(32)
const CAMERA_ELEVATION = THREE.MathUtils.degToRad(16)
/** 取景留白系数 */
const FRAME_PADDING = 1.35

/** 灯光预设表。三盏灯 = 主光给形体、补光救暗部、轮廓光把模型从背景里"抠"出来 */
const LIGHT_PRESETS: Record<
  LightPreset,
  {
    exposure: number
    envIntensity: number
    shadowOpacity: number
    key: { color: number; intensity: number; position: [number, number, number] }
    fill: { color: number; intensity: number; position: [number, number, number] }
    rim: { color: number; intensity: number; position: [number, number, number] }
  }
> = {
  studio: {
    exposure: 1,
    envIntensity: 1,
    shadowOpacity: 0.3,
    key: { color: 0xffffff, intensity: 2.2, position: [3, 4.5, 3] },
    fill: { color: 0xdfe8ff, intensity: 0.55, position: [-4, 2, -1] },
    rim: { color: 0xffffff, intensity: 1.2, position: [-2, 3.5, -4] }
  },
  daylight: {
    exposure: 1.15,
    envIntensity: 1.15,
    shadowOpacity: 0.38,
    key: { color: 0xfff1dc, intensity: 2.9, position: [4, 6, 2.5] },
    fill: { color: 0xbfd4ff, intensity: 0.8, position: [-3, 2, -2] },
    rim: { color: 0xffffff, intensity: 0.9, position: [-1, 4, -5] }
  },
  night: {
    exposure: 0.85,
    envIntensity: 0.35,
    shadowOpacity: 0.5,
    key: { color: 0xbcd2ff, intensity: 1.6, position: [2.5, 3.5, 2] },
    fill: { color: 0x2a3550, intensity: 0.35, position: [-3, 1.5, -2] },
    rim: { color: 0x9fc0ff, intensity: 2.2, position: [-1.5, 2.5, -4.5] }
  }
}

const activePreset = computed(() => LIGHT_PRESETS[props.lightPreset ?? 'studio'])

// ============ 状态 ============
const wrapperRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const loadState = ref<'idle' | 'loading' | 'error'>('idle')
const loadError = ref('')
const modelUrl = ref<string | null>(null)
/** 模型是不是被判成"躺着"并自动扶正过 —— 给界面上的手动开关做初值 */
const upAxisCorrected = ref(false)

// three 对象不进响应式：它们自带庞大的内部引用，Proxy 包一层既慢又容易出怪事
const renderer = shallowRef<THREE.WebGLRenderer | null>(null)
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: OrbitControls | null = null
/** 模型挂在这个组下面：旋转、扶正都是动这个组，不碰模型自身的变换 */
let modelGroup: THREE.Group | null = null
let loadedModel: THREE.Object3D | null = null
/** 只有骨骼没有网格（动画 FBX）时画出来的骨架，没它画面就是空的 */
let skeletonHelper: THREE.SkeletonHelper | null = null
let ground: THREE.Mesh | null = null
let keyLight: THREE.DirectionalLight | null = null
let fillLight: THREE.DirectionalLight | null = null
let rimLight: THREE.DirectionalLight | null = null
let envTarget: THREE.WebGLRenderTarget | null = null
let mixer: THREE.AnimationMixer | null = null
const clock = new THREE.Clock()
let frameId: number | null = null
let resizeObserver: ResizeObserver | null = null
let isUnmounted = false
/** 本帧要不要重画。按需渲染：不动的时候不烧 GPU */
let needsRender = true
/** 归一化后模型的高度，用来把视线对准模型腰部而不是脚底 */
let modelHeight = TARGET_SIZE
/** 加载令牌：切模型时丢弃上一次的迟到结果 */
let loadToken = 0

const originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>()
const presetMaterials = new Map<ViewMode, THREE.Material>()
/** 线框模式是按原材质克隆出来的，换模式时要收回去，否则来回切几次就堆一片 */
let wireframeClones: THREE.Material[] = []

const requestRender = (): void => {
  needsRender = true
}

// ============ 场景搭建 ============

/** 建渲染器。显卡起不来要当场说清楚，别留个黑框让人猜 */
function setupViewer(): boolean {
  const canvas = canvasRef.value
  const wrapper = wrapperRef.value
  if (!canvas || !wrapper) return false

  try {
    const gl = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      // 截图要在任意时刻读回画面，必须保留绘制缓冲
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance'
    })
    // 设备像素比交给 three：它会把绘制缓冲放大到 rect * dpr，再用 CSS 缩回去。
    // 封顶 2 是为了 4K 屏上不至于渲染 4 倍像素。
    gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    gl.outputEncoding = THREE.sRGBEncoding
    gl.toneMapping = THREE.ACESFilmicToneMapping
    gl.shadowMap.enabled = true
    gl.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.value = gl
  } catch (error) {
    loadState.value = 'error'
    loadError.value = error instanceof Error ? error.message : String(error)
    emit('error', loadError.value)
    return false
  }

  scene = new THREE.Scene()
  modelGroup = new THREE.Group()
  scene.add(modelGroup)

  camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.01, 1000)
  camera.position.set(0, TARGET_SIZE * 0.5, TARGET_SIZE * 2)

  controls = new OrbitControls(camera, renderer.value!.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.rotateSpeed = 0.9
  controls.panSpeed = 0.7
  controls.minDistance = TARGET_SIZE * 0.4
  controls.maxDistance = TARGET_SIZE * 12
  // 不让人转到地面以下：一看见穿帮的地板就露馅
  controls.maxPolarAngle = Math.PI * 0.495
  controls.addEventListener('change', requestRender)

  buildEnvironment()
  buildLights()
  buildGround()
  applyPreset()
  resize()
  startLoop()
  return true
}

/**
 * 环境光照。RoomEnvironment 是一个"软箱棚"的小场景，经 PMREM 卷积成环境贴图，
 * PBR 材质靠它才有高光和层次 —— 这是整块画面里最值钱的一行。
 */
function buildEnvironment(): void {
  if (!renderer.value || !scene) return
  const pmrem = new THREE.PMREMGenerator(renderer.value)
  envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04)
  scene.environment = envTarget.texture
  // 背景留空：让页面自己的底色透上来，查看器才像嵌在界面里而不是贴了张图
  scene.background = null
  pmrem.dispose()
}

function buildLights(): void {
  if (!scene) return
  keyLight = new THREE.DirectionalLight(0xffffff, 1)
  keyLight.castShadow = true
  keyLight.shadow.mapSize.set(2048, 2048)
  keyLight.shadow.bias = -0.0005
  keyLight.shadow.normalBias = 0.02
  const shadowCamera = keyLight.shadow.camera
  shadowCamera.near = 0.1
  shadowCamera.far = TARGET_SIZE * 12
  shadowCamera.left = -TARGET_SIZE * 1.6
  shadowCamera.right = TARGET_SIZE * 1.6
  shadowCamera.top = TARGET_SIZE * 1.6
  shadowCamera.bottom = -TARGET_SIZE * 1.6
  shadowCamera.updateProjectionMatrix()

  fillLight = new THREE.DirectionalLight(0xffffff, 0.5)
  rimLight = new THREE.DirectionalLight(0xffffff, 1)
  scene.add(keyLight, fillLight, rimLight)
}

/** 地面只接阴影不画自己：ShadowMaterial 在透明背景上只留下那团影子 */
function buildGround(): void {
  if (!scene) return
  ground = new THREE.Mesh(
    new THREE.PlaneGeometry(TARGET_SIZE * 12, TARGET_SIZE * 12),
    new THREE.ShadowMaterial({ opacity: 0.3 })
  )
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  scene.add(ground)
}

/** 把当前预设铺到灯光、曝光、环境强度和阴影浓度上 */
function applyPreset(): void {
  const preset = activePreset.value
  if (renderer.value) {
    renderer.value.toneMappingExposure = preset.exposure * (props.exposure ?? 1)
  }
  const assign = (
    light: THREE.DirectionalLight | null,
    config: { color: number; intensity: number; position: [number, number, number] }
  ): void => {
    if (!light) return
    light.color.setHex(config.color)
    light.intensity = config.intensity
    light.position.set(...config.position).multiplyScalar(TARGET_SIZE)
  }
  assign(keyLight, preset.key)
  assign(fillLight, preset.fill)
  assign(rimLight, preset.rim)

  if (ground) {
    ;(ground.material as THREE.ShadowMaterial).opacity = preset.shadowOpacity
  }
  applyEnvIntensity(preset.envIntensity)
  requestRender()
}

/** r143 的 scene 还没有 environmentIntensity，只能逐材质设 envMapIntensity */
function applyEnvIntensity(intensity: number): void {
  loadedModel?.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    list.forEach((material) => {
      if ((material as THREE.MeshStandardMaterial).envMapIntensity !== undefined) {
        ;(material as THREE.MeshStandardMaterial).envMapIntensity = intensity
        material.needsUpdate = true
      }
    })
  })
}

// ============ 渲染循环 ============

function startLoop(): void {
  const tick = (): void => {
    frameId = requestAnimationFrame(tick)
    const delta = clock.getDelta()

    if (mixer && props.autoPlay !== false) {
      mixer.update(delta)
      needsRender = true
    }
    if (props.autoRotate && modelGroup) {
      modelGroup.rotation.y += delta * 0.6
      needsRender = true
    }
    // OrbitControls 带阻尼时会自己继续滑一段，update() 动过就要重画
    if (controls?.update()) needsRender = true

    if (needsRender && renderer.value && scene && camera) {
      renderer.value.render(scene, camera)
      needsRender = false
    }
  }
  frameId = requestAnimationFrame(tick)
}

/** 尺寸变了就重设渲染器和相机。绝不手动改 canvas.width —— 那会把 DPR 打回 1x */
function resize(): void {
  const wrapper = wrapperRef.value
  if (!wrapper || !renderer.value || !camera) return
  const { width, height } = wrapper.getBoundingClientRect()
  if (width < 1 || height < 1) return
  renderer.value.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  requestRender()
}

// ============ 加载 ============

function sourceUrl(): string | null {
  const source =
    props.fileUrl ||
    props.filePath ||
    (props.file ? (props.file as File & { path?: string }).path : null)
  if (!source) return null
  return isHttpUrl(source) ? source : (toAssetFileUrl(source) ?? null)
}

function extensionOf(url: string): string {
  const clean = url.split('?')[0].split('#')[0]
  const dot = clean.lastIndexOf('.')
  return dot === -1 ? '' : clean.slice(dot + 1).toLowerCase()
}

/** 贴图是相对模型文件写的，得把目录交给 loader 才解析得出来 */
function directoryOf(url: string): string {
  return url.slice(0, url.lastIndexOf('/') + 1)
}

async function loadModel(url: string): Promise<void> {
  const token = ++loadToken
  loadState.value = 'loading'
  loadError.value = ''
  disposeModel()

  const extension = extensionOf(url)
  const resourcePath = directoryOf(url)

  try {
    let object: THREE.Object3D
    let clips: THREE.AnimationClip[] = []

    if (extension === 'glb' || extension === 'gltf') {
      const loader = new GLTFLoader()
      loader.setResourcePath(resourcePath)
      const draco = new DRACOLoader()
      draco.setDecoderPath('/draco/gltf/')
      loader.setDRACOLoader(draco)
      const gltf = await loader.loadAsync(url)
      object = gltf.scene
      clips = gltf.animations ?? []
      draco.dispose()
    } else if (extension === 'fbx') {
      const loader = new FBXLoader()
      loader.setResourcePath(resourcePath)
      const fbx = await loader.loadAsync(url)
      object = fbx
      clips = fbx.animations ?? []
    } else if (extension === 'obj') {
      const loader = new OBJLoader()
      loader.setResourcePath(resourcePath)
      // 同名 .mtl 有就用，没有就算了 —— OBJ 不带材质，有 mtl 的时候差别很大
      const materials = await loadSiblingMtl(url, resourcePath)
      if (materials) loader.setMaterials(materials)
      object = await loader.loadAsync(url)
    } else {
      throw new Error(`unsupported format: ${extension || 'unknown'}`)
    }

    if (token !== loadToken || isUnmounted) {
      disposeObject(object)
      return
    }

    mountModel(object, clips, extension)
    loadState.value = 'idle'
    emit('load')
  } catch (error) {
    if (token !== loadToken || isUnmounted) return
    loadState.value = 'error'
    loadError.value = error instanceof Error ? error.message : String(error)
    emit('error', loadError.value)
  }
}

async function loadSiblingMtl(
  url: string,
  resourcePath: string
): Promise<MTLLoader.MaterialCreator | null> {
  const mtlUrl = url.replace(/\.obj$/i, '.mtl')
  try {
    const loader = new MTLLoader()
    loader.setResourcePath(resourcePath)
    const materials = await loader.loadAsync(mtlUrl)
    materials.preload()
    return materials
  } catch {
    return null
  }
}

/**
 * 把模型摆正、归一化、放进场景。
 *
 * 归一化这一步是"每个模型进来都长一样"的关键：UE 的 FBX 是厘米、glTF 是米，
 * 原来靠文件后缀乘 100 去猜，猜错就飞出画面。现在按包围盒缩到固定大小，不用猜。
 */
function mountModel(object: THREE.Object3D, clips: THREE.AnimationClip[], extension: string): void {
  if (!scene || !modelGroup) return

  const stats = collectStats(object, clips)

  // 1. 扶正：FBX/OBJ 常见 Z-up（UE、3ds Max 导出），扁平得不像话就转 90°
  const raw = boundsOf(object)
  const rawSize = raw.getSize(new THREE.Vector3())
  const looksLyingDown =
    rawSize.y < Math.max(rawSize.x, rawSize.z) * 0.35 && Math.max(rawSize.x, rawSize.z) > 0
  upAxisCorrected.value = looksLyingDown && (extension === 'fbx' || extension === 'obj')
  if (upAxisCorrected.value) object.rotation.x = -Math.PI / 2
  object.updateMatrixWorld(true)

  // 2. 归一化 + 落地居中：缩到固定大小，水平居中，脚踩 y=0
  const box = boundsOf(object)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const maxDimension = Math.max(size.x, size.y, size.z) || 1
  const scale = TARGET_SIZE / maxDimension
  object.scale.multiplyScalar(scale)
  object.position.sub(center.multiplyScalar(scale))
  object.position.y += (size.y * scale) / 2
  modelHeight = size.y * scale

  // 3. 阴影：模型投、地面接
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.castShadow = true
    mesh.receiveShadow = true
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    list.forEach((material) => {
      // 单面材质的衣服/头发翻过来就是黑的，双面更稳
      material.side = THREE.DoubleSide
    })
  })

  modelGroup.rotation.set(0, 0, 0)
  modelGroup.add(object)
  loadedModel = object

  if (stats.meshCount === 0 && hasBones(object)) {
    skeletonHelper = new THREE.SkeletonHelper(object)
    const material = skeletonHelper.material as THREE.LineBasicMaterial
    material.depthTest = false
    material.transparent = true
    skeletonHelper.renderOrder = 1
    // 挂场景根上：helper 的矩阵直接取 root.matrixWorld，挂 modelGroup 下会把旋转叠两次
    scene.add(skeletonHelper)
  }

  if (clips.length > 0) {
    mixer = new THREE.AnimationMixer(object)
    mixer.clipAction(clips[0]).play()
  }

  applyEnvIntensity(activePreset.value.envIntensity)
  if (props.viewMode && props.viewMode !== 'default') applyViewMode(props.viewMode)
  frameModel()
  emit('modelStats', stats)
}

function hasBones(object: THREE.Object3D): boolean {
  let found = false
  object.traverse((child) => {
    if ((child as THREE.Bone).isBone) found = true
  })
  return found
}

/** 包围盒只认网格；动画 FBX 只有骨骼，得拿骨骼位置兜底，不然缩放算成 NaN */
function boundsOf(object: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3().setFromObject(object)
  if (!box.isEmpty()) return box
  const point = new THREE.Vector3()
  object.updateMatrixWorld(true)
  object.traverse((child) => {
    if ((child as THREE.Bone).isBone) box.expandByPoint(child.getWorldPosition(point))
  })
  return box
}

/** 统计信息在归一化之前算，包围盒报的才是模型自己的尺寸 */
function collectStats(
  object: THREE.Object3D,
  clips: THREE.AnimationClip[]
): {
  vertices: number
  faces: number
  materials: number
  meshCount: number
  textureCount: number
  boundingBox: { x: number; y: number; z: number }
  hasAnimations: boolean
  animationCount: number
} {
  let vertices = 0
  let faces = 0
  let meshCount = 0
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()

  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    meshCount += 1
    const position = mesh.geometry.attributes?.position
    if (position) vertices += position.count
    faces += mesh.geometry.index
      ? Math.floor(mesh.geometry.index.count / 3)
      : Math.floor((position?.count ?? 0) / 3)

    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    list.forEach((material) => {
      if (!material) return
      materials.add(material)
      Object.values(material).forEach((value) => {
        if (value && (value as THREE.Texture).isTexture) textures.add(value as THREE.Texture)
      })
    })
  })

  const size = boundsOf(object).getSize(new THREE.Vector3())
  return {
    vertices,
    faces,
    materials: materials.size,
    meshCount,
    textureCount: textures.size,
    boundingBox: {
      x: Math.round(size.x * 100) / 100,
      y: Math.round(size.y * 100) / 100,
      z: Math.round(size.z * 100) / 100
    },
    hasAnimations: clips.length > 0,
    animationCount: clips.length
  }
}

/**
 * 取景：固定的 3/4 机位，距离按视场角和画面宽高比算，不靠 setTimeout 赌。
 * 视线对准模型腰部（0.55 高），比对准包围盒中心更像人看东西的高度。
 */
function frameModel(): void {
  if (!camera || !controls) return
  const radius = TARGET_SIZE * 0.5
  const vertical = radius / Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV) / 2)
  const horizontal = vertical / Math.min(camera.aspect, 1)
  const distance = Math.max(vertical, horizontal) * FRAME_PADDING

  const target = new THREE.Vector3(0, modelHeight * 0.55, 0)
  camera.position.set(
    target.x + distance * Math.cos(CAMERA_ELEVATION) * Math.sin(CAMERA_AZIMUTH),
    target.y + distance * Math.sin(CAMERA_ELEVATION),
    target.z + distance * Math.cos(CAMERA_ELEVATION) * Math.cos(CAMERA_AZIMUTH)
  )
  controls.target.copy(target)
  controls.update()
  requestRender()
}

// ============ 可视化模式 ============

function getPresetMaterial(mode: ViewMode): THREE.Material | null {
  const cached = presetMaterials.get(mode)
  if (cached) return cached

  let material: THREE.Material | null = null
  if (mode === 'normal') {
    material = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide })
  } else if (mode === 'clay') {
    material = new THREE.MeshStandardMaterial({
      color: 0xd8d8d8,
      roughness: 0.75,
      metalness: 0,
      side: THREE.DoubleSide
    })
  } else if (mode === 'uv') {
    material = new THREE.MeshBasicMaterial({ map: makeCheckerTexture() })
  }
  if (material) presetMaterials.set(mode, material)
  return material
}

function makeCheckerTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const cell = 16
  for (let y = 0; y < 256; y += cell) {
    for (let x = 0; x < 256; x += cell) {
      ctx.fillStyle = ((x + y) / cell) % 2 === 0 ? '#ffffff' : '#7a7a7a'
      ctx.fillRect(x, y, cell, cell)
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  return texture
}

function applyViewMode(mode: ViewMode): void {
  if (!loadedModel) return
  if (mode !== 'default' && originalMaterials.size === 0) saveOriginalMaterials()
  disposeWireframeClones()

  loadedModel.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    const original = originalMaterials.get(mesh)

    if (mode === 'default') {
      if (original) mesh.material = original
      return
    }
    if (mode === 'wireframe') {
      // 线框保留原色：直接换成纯色线框会把材质信息全抹掉
      const toWireframe = (material: THREE.Material): THREE.Material => {
        const cloned = material.clone()
        ;(cloned as THREE.MeshStandardMaterial).wireframe = true
        wireframeClones.push(cloned)
        return cloned
      }
      if (Array.isArray(original)) mesh.material = original.map(toWireframe)
      else if (original) mesh.material = toWireframe(original)
      return
    }
    const preset = getPresetMaterial(mode)
    if (preset) mesh.material = preset
  })
  requestRender()
}

function saveOriginalMaterials(): void {
  loadedModel?.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.isMesh && mesh.material) originalMaterials.set(mesh, mesh.material)
  })
}

// ============ 对外能力 ============

/** 手动扶正：自动判断有时会把地毯、盾牌这类扁平模型判错，留一个开关给人改 */
function toggleUpAxis(): void {
  if (!loadedModel) return
  loadedModel.rotation.x = upAxisCorrected.value ? 0 : -Math.PI / 2
  upAxisCorrected.value = !upAxisCorrected.value
  recenterModel()
  frameModel()
}

/** 转过之后包围盒变了，重新落地居中，不然模型会陷进地里或者浮空 */
function recenterModel(): void {
  if (!loadedModel) return
  loadedModel.position.set(0, 0, 0)
  loadedModel.updateMatrixWorld(true)
  const box = boundsOf(loadedModel)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  loadedModel.position.sub(center)
  loadedModel.position.y += size.y / 2
  modelHeight = size.y
}

/** 截图：临时铺一层不透明底色，否则拿到的是一张透明背景的 JPEG（=一片黑） */
function captureSnapshot(): void {
  const gl = renderer.value
  if (!gl || !scene || !camera) return
  try {
    const clearColor = gl.getClearColor(new THREE.Color())
    const clearAlpha = gl.getClearAlpha()
    gl.setClearColor(new THREE.Color('#15161a'), 1)
    gl.render(scene, camera)
    const base64 = gl.domElement.toDataURL('image/jpeg', 0.82)
    gl.setClearColor(clearColor, clearAlpha)
    gl.render(scene, camera)
    if (base64.startsWith('data:image/jpeg') && base64.length > 5000) emit('snapshot', base64)
  } catch (error) {
    console.error('[ModelViewer] 截图失败:', error)
  }
}

// ============ 清理 ============

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry?.dispose()
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    list.forEach((material) => {
      if (!material) return
      Object.values(material).forEach((value) => {
        if (value && (value as THREE.Texture).isTexture) (value as THREE.Texture).dispose()
      })
      material.dispose()
    })
  })
}

function disposeWireframeClones(): void {
  wireframeClones.forEach((material) => material.dispose())
  wireframeClones = []
}

function disposeModel(): void {
  mixer?.stopAllAction()
  mixer = null
  originalMaterials.clear()
  disposeWireframeClones()
  if (skeletonHelper) {
    scene?.remove(skeletonHelper)
    skeletonHelper.geometry.dispose()
    ;(skeletonHelper.material as THREE.Material).dispose()
    skeletonHelper = null
  }
  if (loadedModel) {
    modelGroup?.remove(loadedModel)
    disposeObject(loadedModel)
    loadedModel = null
  }
  requestRender()
}

// ============ 生命周期 ============

onMounted(() => {
  if (!setupViewer()) return
  resizeObserver = new ResizeObserver(() => resize())
  if (wrapperRef.value) resizeObserver.observe(wrapperRef.value)
  const url = sourceUrl()
  if (url) {
    modelUrl.value = url
    void loadModel(url)
  }
})

onUnmounted(() => {
  isUnmounted = true
  if (frameId !== null) cancelAnimationFrame(frameId)
  resizeObserver?.disconnect()
  resizeObserver = null
  controls?.dispose()
  disposeModel()
  presetMaterials.forEach((material) => {
    ;(material as THREE.MeshBasicMaterial).map?.dispose()
    material.dispose()
  })
  presetMaterials.clear()
  ground?.geometry.dispose()
  ;(ground?.material as THREE.Material | undefined)?.dispose()
  envTarget?.dispose()
  // 显卡上下文数量有限，不还回去的话开几次查看器就再也起不来了
  renderer.value?.dispose()
  renderer.value = null
  scene = null
  camera = null
  controls = null
})

watch(
  () => [props.file, props.filePath, props.fileUrl],
  () => {
    const url = sourceUrl()
    modelUrl.value = url
    if (!url) {
      loadToken += 1
      disposeModel()
      loadState.value = 'idle'
      loadError.value = ''
      return
    }
    if (renderer.value) void loadModel(url)
  }
)

watch(() => [props.lightPreset, props.exposure], applyPreset)

watch(
  () => props.viewMode,
  (mode) => {
    if (mode) applyViewMode(mode)
  }
)

watch(
  () => props.autoRotate,
  (enabled) => {
    if (!enabled && modelGroup) {
      // 停下来就把角度归位，否则下次进来模型是歪的
      modelGroup.rotation.y = 0
    }
    requestRender()
  }
)

defineExpose({
  /** 外部容器尺寸变了（比如侧栏收起）时叫一声 */
  forceResize: resize,
  /** 回到默认机位 */
  resetView: frameModel,
  toggleUpAxis,
  captureSnapshot,
  upAxisCorrected
})
</script>

<template>
  <div ref="wrapperRef" class="viewer-wrapper">
    <canvas ref="canvasRef" class="viewer-canvas" :class="{ hidden: !modelUrl }" />

    <div v-if="loadState === 'loading'" class="load-overlay">
      <AppSpin />
      <p class="load-text">{{ $t('modelViewer.loading') }}</p>
    </div>
    <div v-else-if="loadState === 'error'" class="load-overlay">
      <PhWarningCircle :size="28" class="load-error-icon" />
      <p class="load-text">{{ $t('modelViewer.loadFailed') }}</p>
      <p class="load-reason">{{ loadError }}</p>
    </div>

    <!-- 没有模型时才是空状态：这里写 v-else 会在加载成功后糊在模型上 -->
    <div v-else-if="!modelUrl" class="empty-state">
      <PhCube :size="40" class="empty-icon" />
      <p class="empty-title">{{ $t('modelViewer.emptyState.title') }}</p>
      <p class="empty-hint">{{ $t('modelViewer.emptyState.hint') }}</p>
      <p class="empty-formats">FBX · OBJ · GLB · GLTF</p>
    </div>
  </div>
</template>

<style scoped lang="less">
/*
 * 背景是一块"影棚天幕"：中心稍亮、四周压暗。
 * 两件事：一是给画面深度，二是地面那团接触阴影在纯黑底上根本看不见，
 * 得有一点底色它才落得住。canvas 本身是透明的，这层从后面透上来。
 */
.viewer-wrapper {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 320px;
  overflow: hidden;
  border-radius: var(--radius-container);
  background:
    radial-gradient(ellipse 70% 60% at 50% 42%, var(--color-bg-surface-hover) 0%, transparent 75%),
    var(--color-bg-page);
}

.viewer-canvas {
  display: block;
  width: 100%;
  height: 100%;

  &.hidden {
    visibility: hidden;
  }
}

.load-overlay,
.empty-state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  pointer-events: none;
}

/* 浮在 3D 画面上，底色和字得自带对比，不能指望背后是什么 */
.load-overlay {
  background: var(--color-bg-overlay);
  color: var(--color-text-on-solid);
}

.load-text {
  margin: 0;
  font-size: var(--font-size-sm);
}

.load-reason {
  margin: 0;
  max-width: 70%;
  font-size: var(--font-size-xs);
  font-family: var(--font-family-mono);
  color: var(--color-text-muted);
  text-align: center;
  word-break: break-all;
}

.load-error-icon {
  color: var(--color-danger-text);
}

.empty-icon {
  color: var(--color-text-muted);
  opacity: 0.55;
}

.empty-title {
  margin: 0;
  font-size: var(--font-size-base);
  color: var(--color-text-secondary);
}

.empty-hint {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.empty-formats {
  margin: var(--space-2) 0 0;
  font-size: var(--font-size-xs);
  font-family: var(--font-family-mono);
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
  opacity: 0.7;
}
</style>
