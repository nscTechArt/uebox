import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import * as THREE from 'three'

/**
 * 查看器的取景规矩。
 *
 * 这些是"看着 low"的直接来源，所以要有测试盯着：
 * - 模型按包围盒归一化到固定大小 —— 原来按文件后缀乘 100 去猜单位，猜错就飞出画面
 * - 脚踩地面、水平居中 —— 阴影才落得住，转起来才不晃
 * - UE 导出的 FBX 是 Z-up，进来会躺着，要自动扶正，扶错了还得能手动扳回去
 * - 没有模型才显示空状态（加载成功后 loadState 回到 idle，写 v-else 会糊在模型上）
 */

/** 测试环境没有 WebGL，把 GPU 相关的两块换成壳子，three 的数学部分保持真的 */
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof THREE>()
  class FakeRenderer {
    domElement = document.createElement('canvas')
    shadowMap = { enabled: false, type: 0 }
    outputEncoding = 0
    toneMapping = 0
    toneMappingExposure = 1
    setPixelRatio = vi.fn()
    setSize = vi.fn()
    render = vi.fn()
    dispose = vi.fn()
    setClearColor = vi.fn()
    getClearAlpha = (): number => 0
    getClearColor = (target: THREE.Color): THREE.Color => target
  }
  class FakePMREM {
    fromScene = (): { texture: object; dispose: () => void } => ({
      texture: {},
      dispose: () => {}
    })
    dispose = vi.fn()
  }
  return { ...actual, WebGLRenderer: FakeRenderer, PMREMGenerator: FakePMREM }
})

/** 加载器返回什么由每条用例自己摆 */
let fbxResult: THREE.Object3D | null = null
let fbxError: Error | null = null

vi.mock('three/examples/jsm/loaders/FBXLoader.js', () => ({
  FBXLoader: class {
    setResourcePath = vi.fn()
    async loadAsync(): Promise<THREE.Object3D> {
      if (fbxError) throw fbxError
      return fbxResult!
    }
  }
}))

import ModelViewer from './ModelViewer.vue'

const $t = (key: string): string => key

/** 造一个指定尺寸的盒子当模型 */
function makeBox(x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(x, y, z),
    new THREE.MeshStandardMaterial({ color: 0xffffff })
  )
  mesh.name = 'probe'
  return mesh
}

function mountViewer(props: Record<string, unknown> = {}): ReturnType<typeof mount> {
  return mount(ModelViewer, { props, global: { mocks: { $t } } })
}

/** 等加载那串 await 走完 */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await nextTick()
}

function worldBox(object: THREE.Object3D): THREE.Box3 {
  object.updateMatrixWorld(true)
  return new THREE.Box3().setFromObject(object)
}

beforeEach(() => {
  fbxResult = null
  fbxError = null
})

describe('ModelViewer 的空状态', () => {
  it('没有模型时显示空状态', () => {
    const wrapper = mountViewer()
    expect(wrapper.find('.empty-state').exists()).toBe(true)
    wrapper.unmount()
  })

  it('加载成功后空状态必须让开，不能糊在模型上', async () => {
    fbxResult = makeBox(10, 30, 10)
    const wrapper = mountViewer({ filePath: 'H:/素材/a.fbx' })
    await settle()

    expect(wrapper.emitted('load')).toHaveLength(1)
    expect(wrapper.find('.empty-state').exists()).toBe(false)
    expect(wrapper.find('.load-overlay').exists()).toBe(false)
    wrapper.unmount()
  })

  it('加载失败显示原因，不退回空状态', async () => {
    fbxError = new Error('文件坏了')
    const wrapper = mountViewer({ filePath: 'H:/素材/坏的.fbx' })
    await settle()

    expect(wrapper.find('.load-reason').text()).toBe('文件坏了')
    expect(wrapper.find('.empty-state').exists()).toBe(false)
    expect(wrapper.emitted('error')?.[0]).toEqual(['文件坏了'])
    wrapper.unmount()
  })

  it('模型清掉后空状态回来', async () => {
    fbxResult = makeBox(10, 30, 10)
    const wrapper = mountViewer({ filePath: 'H:/素材/a.fbx' })
    await settle()

    await wrapper.setProps({ filePath: null })
    await settle()

    expect(wrapper.find('.empty-state').exists()).toBe(true)
    wrapper.unmount()
  })
})

describe('ModelViewer 的取景', () => {
  it('大模型和小模型都缩到同样大小，不靠文件后缀猜单位', async () => {
    fbxResult = makeBox(20, 400, 20) // 厘米单位的角色，UE 导出的常见尺度
    const huge = mountViewer({ filePath: 'H:/素材/big.fbx' })
    await settle()
    const hugeSize = worldBox(fbxResult).getSize(new THREE.Vector3())

    fbxResult = makeBox(0.2, 1.8, 0.2) // 米单位的同一个角色
    const tiny = mountViewer({ filePath: 'H:/素材/small.fbx' })
    await settle()
    const tinySize = worldBox(fbxResult).getSize(new THREE.Vector3())

    expect(Math.max(hugeSize.x, hugeSize.y, hugeSize.z)).toBeCloseTo(2, 5)
    expect(Math.max(tinySize.x, tinySize.y, tinySize.z)).toBeCloseTo(2, 5)
    huge.unmount()
    tiny.unmount()
  })

  it('模型落在地面上、水平居中，影子才有地方落', async () => {
    fbxResult = makeBox(10, 30, 10)
    const wrapper = mountViewer({ filePath: 'H:/素材/a.fbx' })
    await settle()

    const box = worldBox(fbxResult)
    expect(box.min.y).toBeCloseTo(0, 5)
    const center = box.getCenter(new THREE.Vector3())
    expect(center.x).toBeCloseTo(0, 5)
    expect(center.z).toBeCloseTo(0, 5)
    wrapper.unmount()
  })

  it('躺着的 FBX（Z-up 导出）自动扶正', async () => {
    // 高度远小于长宽 = 躺着
    fbxResult = makeBox(60, 5, 180)
    const wrapper = mountViewer({ filePath: 'H:/素材/lying.fbx' })
    await settle()

    expect(fbxResult.rotation.x).toBeCloseTo(-Math.PI / 2, 5)
    // 扶正之后最高的那一维应该是 Y
    const size = worldBox(fbxResult).getSize(new THREE.Vector3())
    expect(size.y).toBeGreaterThan(size.x)
    wrapper.unmount()
  })

  it('本来就站着的模型不去动它', async () => {
    fbxResult = makeBox(20, 180, 20)
    const wrapper = mountViewer({ filePath: 'H:/素材/standing.fbx' })
    await settle()

    expect(fbxResult.rotation.x).toBeCloseTo(0, 5)
    wrapper.unmount()
  })

  it('自动判错了能手动扳回去，扳完还是落在地面上', async () => {
    fbxResult = makeBox(60, 5, 180) // 地毯这种真的就是扁的，会被判成躺着
    const wrapper = mountViewer({ filePath: 'H:/素材/carpet.fbx' })
    await settle()
    expect(fbxResult.rotation.x).toBeCloseTo(-Math.PI / 2, 5)
    ;(wrapper.vm as unknown as { toggleUpAxis: () => void }).toggleUpAxis()
    await nextTick()

    expect(fbxResult.rotation.x).toBeCloseTo(0, 5)
    expect(worldBox(fbxResult).min.y).toBeCloseTo(0, 5)
    wrapper.unmount()
  })
})

describe('ModelViewer 的统计', () => {
  it('面数、材质、包围盒按模型原始尺寸报，不是归一化之后的', async () => {
    fbxResult = makeBox(10, 30, 20)
    const wrapper = mountViewer({ filePath: 'H:/素材/a.fbx' })
    await settle()

    const stats = wrapper.emitted('modelStats')?.[0]?.[0] as {
      faces: number
      materials: number
      meshCount: number
      boundingBox: { x: number; y: number; z: number }
    }
    expect(stats.meshCount).toBe(1)
    expect(stats.materials).toBe(1)
    expect(stats.faces).toBe(12) // 立方体 6 面 × 2 个三角形
    expect(stats.boundingBox).toEqual({ x: 10, y: 30, z: 20 })
    wrapper.unmount()
  })
})
