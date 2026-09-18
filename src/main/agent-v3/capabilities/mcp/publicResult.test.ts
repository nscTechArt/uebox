/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { PUBLIC_RESULT_TOOLS, toStructuredContent } from './publicResult'

/**
 * 这一层的价值全在「缺失」和「确认为空」分得开。
 *
 * 旧插件不报 `selectedActorCount` / `world` / `camera_source` 这些后加的字段。
 * 补成 0 或 false 之后，调用方拿到的是一个**它以为确认过**的结果 ——
 * 「用户什么都没选」和「这个插件版本不告诉我们选了几个」会被当成同一件事，
 * 然后照着前者继续往下做。
 */
describe('toStructuredContent', () => {
  it('没有 serializer 的工具不返回结构化结果', () => {
    expect(toStructuredContent('ue_run_python_script', { anything: 1 })).toBeUndefined()
  })

  it('details 不是对象时不返回结构化结果', () => {
    expect(toStructuredContent('ue_get_selection', undefined)).toBeUndefined()
    expect(toStructuredContent('ue_get_selection', '一段文本')).toBeUndefined()
    expect(toStructuredContent('ue_get_selection', [1, 2])).toBeUndefined()
  })

  /**
   * 有 serializer 的工具是一份对外接口清单，加一个就是多一份要长期维持形状的
   * 承诺，所以钉死在这里。
   *
   * 撤销那两个是外部评审之后补的：CLI 要靠比对撤销栈的前后状态来核实撤销
   * 真的生效了，而只给一段中文摘要的话，它唯一能做的就是相信工具的自述。
   */
  it('对外有结构化结果的就这几个', () => {
    expect(PUBLIC_RESULT_TOOLS.sort()).toEqual([
      'ue_get_actor',
      'ue_get_selection',
      'ue_screenshot',
      'ue_session_health',
      'ue_undo',
      'ue_undo_history'
    ])
  })
})

describe('ue_get_selection', () => {
  it('把焦点、图、节点、Actor、内容浏览器都挑出来', () => {
    const result = toStructuredContent('ue_get_selection', {
      success: true,
      focusedEditor: {
        type: 'blueprint',
        name: 'BP_Door',
        path: '/Game/BP_Door',
        isModified: true
      },
      focusedGraph: { name: 'EventGraph', path: '/Game/BP_Door:EventGraph', node_count: 12 },
      selectedNodes: [{ node_id: 'GUID-1', class: 'K2Node_CallFunction', title: 'Print String' }],
      selectedNodeCount: 1,
      selectedNodesTruncated: false,
      selectedActors: [
        { name: 'Cube_1', label: 'Cube', class: 'StaticMeshActor', path: '/Game/L1' }
      ],
      selectedActorCount: 1,
      selectedActorsTruncated: false,
      contentBrowser: {
        selectedAssets: [{ name: 'M_Wood', path: '/Game/M_Wood', class: 'Material' }],
        selectedAssetCount: 1,
        selectedAssetsTruncated: false,
        selectedFolders: ['/Game/Props']
      },
      summary: '焦点：blueprint BP_Door'
    })

    expect(result).toMatchObject({
      focusedEditor: { type: 'blueprint', name: 'BP_Door', isModified: true },
      focusedGraph: { name: 'EventGraph', nodeCount: 12 },
      selectedNodes: [{ nodeId: 'GUID-1', title: 'Print String' }],
      selectedActorCount: 1,
      selectedActors: [{ name: 'Cube_1', label: 'Cube' }],
      contentBrowser: { selectedAssetCount: 1, selectedFolders: ['/Game/Props'] },
      summary: '焦点：blueprint BP_Door'
    })
  })

  /** 「什么都没选」是一个能下结论的事实，要如实报成空数组 + 0 */
  it('确认没选中任何东西时是空数组和 0，不是 null', () => {
    const result = toStructuredContent('ue_get_selection', {
      success: true,
      selectedActors: [],
      selectedActorCount: 0,
      selectedActorsTruncated: false
    })

    expect(result).toMatchObject({
      selectedActors: [],
      selectedActorCount: 0,
      selectedActorsTruncated: false
    })
  })

  /** 旧插件根本不报这几个字段 —— 这时候只能说「不知道」 */
  it('旧插件缺字段时给 null，不冒充为已确认的空结果', () => {
    const result = toStructuredContent('ue_get_selection', { success: true }) as Record<
      string,
      unknown
    >

    expect(result.selectedActors).toBeNull()
    expect(result.selectedActorCount).toBeNull()
    expect(result.selectedActorsTruncated).toBeNull()
    expect(result.focusedEditor).toBeNull()
    expect(result.contentBrowser).toBeNull()
  })

  /**
   * 数组本身就是被截断过的那 50 条，它的长度**不是**总数。
   * 拿长度当 count 会让「共 137 个」被报成「共 50 个」。
   */
  it('有数组但没有 count 时，不拿数组长度冒充总数', () => {
    const result = toStructuredContent('ue_get_selection', {
      success: true,
      selectedActors: [{ name: 'A' }, { name: 'B' }]
    }) as Record<string, unknown>

    expect((result.selectedActors as unknown[]).length).toBe(2)
    expect(result.selectedActorCount).toBeNull()
  })
})

describe('ue_get_actor', () => {
  const DETAILS = {
    success: true,
    count: 2,
    total_found: 137,
    actors: [
      {
        name: 'Cube_1',
        path: '/Game/L1.L1:PersistentLevel.Cube_1',
        class: 'StaticMeshActor',
        blueprint_path: '/Game/BP_Cube',
        folder_path: 'Props',
        transform: {
          location: { x: 100, y: 0, z: -19.5 },
          rotation: { pitch: 0, yaw: 90, roll: 0 },
          scale: { x: 1, y: 1, z: 2 }
        },
        bounds: { x: 100, y: 100, z: 200 }
      },
      { name: 'Cube_2', path: '/Game/L1.L1:PersistentLevel.Cube_2', class: 'StaticMeshActor' }
    ],
    system_actors_excluded: 144,
    message: '找到 2 个 Actor（共 137 个，显示前 2 个）'
  }

  /**
   * §4 的硬要求：不能让调用方以为前 N 条就是全部。
   * 真机上「有 137 个匹配项却谎报 2 个」的代价是模型据此说「场景里只有两个」。
   */
  it('三个计数一起给，truncated 由总数算出来', () => {
    expect(toStructuredContent('ue_get_actor', DETAILS)).toMatchObject({
      returnedCount: 2,
      totalCount: 137,
      truncated: true
    })
  })

  it('总数等于返回数时 truncated 为 false', () => {
    expect(toStructuredContent('ue_get_actor', { ...DETAILS, count: 137 })).toMatchObject({
      truncated: false
    })
  })

  /** 不知道总数就不知道有没有截断，猜一个 false 等于替插件编事实 */
  it('缺 total_found 时 totalCount 和 truncated 都是 null', () => {
    const result = toStructuredContent('ue_get_actor', {
      success: true,
      count: 2,
      actors: []
    }) as Record<string, unknown>

    expect(result.returnedCount).toBe(2)
    expect(result.totalCount).toBeNull()
    expect(result.truncated).toBeNull()
  })

  /**
   * 裸数字 `-19.5` 按米读、按厘米读都成立。不换算，但必须说清楚单位 ——
   * 见 `tools/ueUnits.ts` 文件头记的那次事故。
   */
  it('变换原样给出，单位随数据一起声明，不替用户换成米', () => {
    const result = toStructuredContent('ue_get_actor', DETAILS) as Record<string, unknown>
    const actors = result.actors as Array<Record<string, unknown>>

    expect(actors[0].transform).toEqual({
      location: { x: 100, y: 0, z: -19.5 },
      rotation: { pitch: 0, yaw: 90, roll: 0 },
      scale: { x: 1, y: 1, z: 2 }
    })
    expect(result.units).toEqual({
      location: 'cm',
      rotation: 'deg',
      scale: 'multiplier',
      bounds: 'cm'
    })
  })

  it('没有 transform 的 Actor 给 null，不拼一个原点出来', () => {
    const result = toStructuredContent('ue_get_actor', DETAILS) as Record<string, unknown>
    const actors = result.actors as Array<Record<string, unknown>>

    expect(actors[1].transform).toBeNull()
    expect(actors[1].bounds).toBeNull()
    expect(actors[1].blueprintPath).toBeNull()
  })

  it('朝向那句人话原样透出，没有就 null', () => {
    const details = {
      ...DETAILS,
      actors: [
        {
          ...(DETAILS.actors[0] as Record<string, unknown>),
          orientation: '方向光：⚠️ 太阳在地平线以下 30°'
        },
        DETAILS.actors[1]
      ]
    }
    const result = toStructuredContent('ue_get_actor', details) as Record<string, unknown>
    const actors = result.actors as Array<Record<string, unknown>>

    expect(actors[0].orientation).toContain('地平线以下')
    expect(actors[1].orientation).toBeNull()
  })

  /** 分量缺一个的向量整体作废：`{x, y}` 拼成 `{x, y, z: 0}` 是在编一个坐标 */
  it('向量分量不全时整体作废', () => {
    const result = toStructuredContent('ue_get_actor', {
      success: true,
      count: 1,
      actors: [{ name: 'A', transform: { location: { x: 1, y: 2 } } }]
    }) as Record<string, unknown>

    expect((result.actors as Array<Record<string, unknown>>)[0].transform).toMatchObject({
      location: null
    })
  })
})

describe('ue_screenshot', () => {
  it('挑出原始文件路径、尺寸、世界、机位和就绪信息', () => {
    const result = toStructuredContent('ue_screenshot', {
      success: true,
      path: 'D:/Games/Demo/Saved/Screenshots/UAL/shot.png',
      filename: 'shot.png',
      width: 1920,
      height: 1080,
      saved: true,
      world: 'editor',
      view: 'viewport',
      camera_source: 'viewport',
      camera_location: { x: 0, y: 0, z: 500 },
      camera_rotation: { pitch: -30, yaw: 0, roll: 0 },
      pending_shaders: 3,
      pending_assets: 0,
      streaming_in_flight: 0,
      message: '截图已成功获取'
    })

    expect(result).toMatchObject({
      // 这个路径是唯一可用的图像来源：结果里那张 base64 已经被压到 768px
      path: 'D:/Games/Demo/Saved/Screenshots/UAL/shot.png',
      width: 1920,
      height: 1080,
      saved: true,
      world: 'editor',
      cameraSource: 'viewport',
      cameraLocation: { x: 0, y: 0, z: 500 },
      pendingShaders: 3,
      units: { cameraLocation: 'cm', cameraRotation: 'deg' }
    })
  })

  /**
   * 老插件不回 `world` / `camera_source`。
   * 默认填成 `editor` / `viewport` 等于替插件编一个我们没确认的事实 ——
   * 而一张图的结论对不对，取决于它是从哪儿拍的。
   */
  it('旧插件缺 world / camera_source 时给 null，不填默认值', () => {
    const result = toStructuredContent('ue_screenshot', {
      success: true,
      path: 'C:/tmp/a.png',
      width: 1920,
      height: 1080,
      saved: true
    }) as Record<string, unknown>

    expect(result.world).toBeNull()
    expect(result.view).toBeNull()
    expect(result.cameraSource).toBeNull()
    expect(result.pendingShaders).toBeNull()
  })

  it('保存失败时如实报 saved:false 并带上原因', () => {
    const result = toStructuredContent('ue_screenshot', {
      success: true,
      path: 'C:/tmp/a.png',
      saved: false,
      save_error: '磁盘已满'
    })

    expect(result).toMatchObject({ saved: false, saveError: '磁盘已满' })
  })
})

describe('ue_session_health', () => {
  /**
   * 这个工具的连接清单原来一个字都出不来（`defineTool` 的 `toContent()`
   * 只转 text），而 `uebox projects list` / `doctor` 要的就是它。
   */
  it('连接清单和进程清单都转成结构化字段', () => {
    const result = toStructuredContent('ue_session_health', {
      success: true,
      state: 'connected',
      connections: [
        {
          connection_id: 'conn-a',
          project_name: 'Demo',
          project_path: 'D:/Games/Demo',
          engine_version: '5.5',
          is_current_target: true
        }
      ],
      editor_processes: [
        { pid: 1234, project_name: 'Demo', project_path: 'D:/Games/Demo', connected: true }
      ],
      current_target_connection_id: 'conn-a',
      waited_seconds: 0,
      summary: '连着'
    })

    expect(result).toMatchObject({
      state: 'connected',
      connections: [
        {
          connectionId: 'conn-a',
          projectName: 'Demo',
          projectPath: 'D:/Games/Demo',
          engineVersion: '5.5',
          isCurrentTarget: true
        }
      ],
      editorProcesses: [{ pid: 1234, connected: true }],
      currentTargetConnectionId: 'conn-a',
      waitedSeconds: 0
    })
  })

  it('没有连接时是空数组，state 如实报', () => {
    const result = toStructuredContent('ue_session_health', {
      success: true,
      state: 'not_running',
      connections: [],
      editor_processes: [],
      waited_seconds: 0,
      summary: '编辑器没在跑'
    })

    expect(result).toMatchObject({ state: 'not_running', connections: [], editorProcesses: [] })
  })
})
