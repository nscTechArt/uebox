import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { computed, ref } from 'vue'
import { describe, expect, it } from 'vitest'

/**
 * 分组筛选：分组是筛选条件，不是文件夹。这条测试盯的是三件会直接坑到用户的事：
 * - 「全部」要真的是全部（分组里的工程也在），不能像以前那样把它们藏起来
 * - 选中某个分组只留这一组的工程
 * - 搜索和筛选叠加，而不是互相顶掉
 */
const extract = (name: string): string => {
  const source = parse(
    readFileSync('src/renderer/src/views/Home/components/Project/ProjectSection.vue', 'utf8')
  ).descriptor.scriptSetup!.content
  const ast = ts.createSourceFile('project.ts', source, ts.ScriptTarget.Latest, true)
  const declaration = ast.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((item) => item.name.getText(ast) === name)
  )!
  return ts.transpileModule(declaration.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
}

type Project = { projectKey: string; projectName: string }

const inCollection: Project = { projectKey: 'a', projectName: 'RealBiomesDesert' }
const loose: Project = { projectKey: 'b', projectName: 'LooseProject' }

const buildBaseProjects = (
  activeKey: string,
  searchHit: Project[] = [inCollection, loose]
): { value: Project[] } => {
  const searchedProjects = ref(searchHit)
  const activeFilterKey = ref(activeKey)
  const collectionMembers = ref(new Map([['col-1', new Set(['a'])]]))
  const projectsInCollections = ref(new Set(['a']))
  return new Function(
    'computed',
    'searchedProjects',
    'activeFilterKey',
    'collectionMembers',
    'projectsInCollections',
    'FILTER_ALL',
    'FILTER_UNGROUPED',
    extract('baseProjects') + '; return baseProjects;'
  )(
    computed,
    searchedProjects,
    activeFilterKey,
    collectionMembers,
    projectsInCollections,
    '__all__',
    '__ungrouped__'
  )
}

/**
 * 版本筛选和搜索是叠加的，而且分组按钮的计数读的也是这一份 —— 两边算的不是
 * 同一批工程的话，按钮上标着 6、点进去只有 2，那个 6 就是在骗人。
 */
const buildSearchedProjects = (
  version: string,
  hits: Array<{ projectKey: string; EngineAssociation: string }>
): { value: Array<{ projectKey: string }> } => {
  const filteredProjects = ref(hits)
  const engineFilter = ref(version)
  const engineLabel = (association?: string | null): string => String(association || 'N/A')
  return new Function(
    'computed',
    'filteredProjects',
    'engineFilter',
    'engineLabel',
    extract('searchedProjects') + '; return searchedProjects;'
  )(computed, filteredProjects, engineFilter, engineLabel)
}

describe('engine version filter', () => {
  const hits = [
    { projectKey: 'a', EngineAssociation: '5.5' },
    { projectKey: 'b', EngineAssociation: '5.6' }
  ]

  it('keeps everything when no version is picked', () => {
    expect(buildSearchedProjects('', hits).value.map((p) => p.projectKey)).toEqual(['a', 'b'])
  })

  it('narrows to the picked version', () => {
    expect(buildSearchedProjects('5.6', hits).value.map((p) => p.projectKey)).toEqual(['b'])
  })
})

/**
 * 拖到分组按钮上：dragover 里必须把 dropEffect 写成 move。不写的话 Chromium 拿默认的
 * copy 去跟 effectAllowed('move') 对，对不上就落成 none —— 光标变禁用图标，drop 不发。
 */
const buildDragOverFilter = (): ((e: unknown, chip: unknown) => void) => {
  const draggingProjectKey = ref<string | null>('a')
  const dragOverFilterKey = ref<string | null>(null)
  return new Function(
    'draggingProjectKey',
    'dragOverFilterKey',
    'FILTER_ALL',
    extract('handleDragOverFilter') + '; return handleDragOverFilter;'
  )(draggingProjectKey, dragOverFilterKey, '__all__')
}

describe('dropping a project onto a group button', () => {
  it('asks for a move so the cursor is not the no-drop icon', () => {
    const dataTransfer = { dropEffect: 'copy' }
    buildDragOverFilter()({ dataTransfer }, { key: 'col-1', collectionKey: 'col-1' })
    expect(dataTransfer.dropEffect).toBe('move')
  })

  it('rejects 全部, which is not a place things can go', () => {
    const dataTransfer = { dropEffect: 'copy' }
    buildDragOverFilter()({ dataTransfer }, { key: '__all__', collectionKey: null })
    expect(dataTransfer.dropEffect).toBe('none')
  })
})

/**
 * 解散分组：空分组里什么都没有，解散它没有任何东西可丢，那句二次确认纯属挡路。
 * 有工程的分组才值得问一句。
 */
const buildFilterMenuClick = (
  memberCount: number
): {
  click: (key: string) => Promise<void>
  dissolved: string[]
  confirmed: string[]
  renamed: string[]
} => {
  const dissolved: string[] = []
  const confirmed: string[] = []
  const renamed: string[] = []
  const members = new Set(Array.from({ length: memberCount }, (_, i) => `p${i}`))
  const click = new Function(
    'activeFilterChip',
    'collectionMembers',
    'openCollectionModal',
    'dissolveCollection',
    'confirmDialog',
    't',
    extract('handleFilterMenuClick') + '; return handleFilterMenuClick;'
  )(
    ref({ collectionKey: 'col-1', label: 'UE 5.6' }),
    computed(() => new Map([['col-1', members]])),
    (key: string) => renamed.push(key),
    async (key: string) => {
      dissolved.push(key)
    },
    (options: { title: string }) => confirmed.push(options.title),
    (key: string) => key
  )
  return { click, dissolved, confirmed, renamed }
}

describe('dissolving a group', () => {
  it('just does it when the group is empty', async () => {
    const { click, dissolved, confirmed } = buildFilterMenuClick(0)
    await click('dissolve-collection')
    expect(dissolved).toEqual(['col-1'])
    expect(confirmed).toEqual([])
  })

  it('asks first when there are projects inside', async () => {
    const { click, dissolved, confirmed } = buildFilterMenuClick(3)
    await click('dissolve-collection')
    expect(dissolved).toEqual([])
    expect(confirmed).toHaveLength(1)
  })

  it('opens the shared name modal to rename', async () => {
    const { click, renamed } = buildFilterMenuClick(3)
    await click('rename-collection')
    expect(renamed).toEqual(['col-1'])
  })
})

/**
 * 版本筛选的选项只列库里真有的版本：给一个点进去空空如也的「UE 5.2」，
 * 用户得先点一下才知道这里没有 5.2 的工程 —— 那一下是白点的。
 */
const buildEngineOptions = (
  list: Array<{ EngineAssociation: string }>
): { value: Array<{ value: string; label: string }> } => {
  const projects = ref(list)
  const engineLabel = (association?: string | null): string => String(association || 'N/A')
  return new Function(
    'computed',
    'projects',
    'engineLabel',
    't',
    extract('engineOptions') + '; return engineOptions;'
  )(computed, projects, engineLabel, (key: string) => key)
}

describe('engine version options', () => {
  it('lists only the versions that are actually in the library, newest first', () => {
    const options = buildEngineOptions([
      { EngineAssociation: '5.5' },
      { EngineAssociation: '5.6' },
      { EngineAssociation: '5.5' }
    ])
    expect(options.value.map((o) => o.value)).toEqual(['', '5.6', '5.5'])
  })
})

/**
 * 一个工程可以同时在几个分组里，右键菜单就得每个分组各给一条「移出「XXX」」——
 * 只给一条的话，用户没法说清楚要退哪个组。
 */
const buildMenuItems = (
  memberships: Array<{ collectionKey: string; name: string }>
): Array<{ key?: string; label?: string }> =>
  new Function(
    't',
    'PhPlayCircle',
    'PhCode',
    'PhFolderOpen',
    'PhPushPin',
    'PhPencilSimple',
    'PhImage',
    'PhPlugs',
    'PhFolderMinus',
    'PhTrash',
    extract('buildMenuItems') + '; return buildMenuItems;'
  )(
    (key: string, params?: Record<string, string>) => (params ? `${key}:${params.name}` : key),
    ...Array(9).fill(null)
  )(false, null, null, memberships)

describe('removing a project from a group', () => {
  it('offers one entry per group the project is in', () => {
    const items = buildMenuItems([
      { collectionKey: 'col-1', name: 'UE 5.5' },
      { collectionKey: 'col-2', name: '教学用' }
    ])
    expect(items.filter((i) => i.key?.startsWith('remove-from-collection:')).map((i) => i.key)) //
      .toEqual(['remove-from-collection:col-1', 'remove-from-collection:col-2'])
    expect(items.find((i) => i.key === 'remove-from-collection:col-2')?.label).toContain('教学用')
  })

  it('offers none when the project is not in any group', () => {
    expect(buildMenuItems([]).some((i) => i.key?.startsWith('remove-from-collection'))).toBe(false)
  })
})

/**
 * 切标签回来筛选还在。首页没有 keepAlive，整个组件是重新建的，所以筛选状态
 * 从 localStorage 里恢复 —— 而恢复出来的分组 / 版本，必须活过首屏那阵子：
 * 工程、分组、自编译引擎的版本号是三趟异步回来的，校验跑在数据齐之前，
 * 会拿一张还没凑齐的表把刚恢复的筛选判成「不存在」，当场清掉。
 */
const buildCollectionGuard = (
  restored: string
): { guard: (input: [Array<{ key: string }>, boolean]) => void; current: { value: string } } => {
  const activeFilterKey = ref(restored)
  const guard = new Function(
    'activeFilterKey',
    'FILTER_ALL',
    extract('dropMissingCollectionFilter') + '; return dropMissingCollectionFilter;'
  )(activeFilterKey, '__all__')
  return { guard, current: activeFilterKey }
}

describe('restoring the filter after the tab comes back', () => {
  it('leaves the restored group alone while the first load is still running', () => {
    const { guard, current } = buildCollectionGuard('col-1')
    // 分组还没拉回来，此时表里只有「全部」
    guard([[{ key: '__all__' }], false])
    expect(current.value).toBe('col-1')
  })

  it('keeps it once the group really is there', () => {
    const { guard, current } = buildCollectionGuard('col-1')
    guard([[{ key: '__all__' }, { key: 'col-1' }], true])
    expect(current.value).toBe('col-1')
  })

  it('falls back to 全部 when the group was dissolved while away', () => {
    const { guard, current } = buildCollectionGuard('col-1')
    guard([[{ key: '__all__' }], true])
    expect(current.value).toBe('__all__')
  })
})

const buildEngineGuard = (
  restored: string
): { guard: (input: [Array<{ value: string }>, boolean]) => void; current: { value: string } } => {
  const engineFilter = ref(restored)
  const guard = new Function(
    'engineFilter',
    extract('dropMissingEngineFilter') + '; return dropMissingEngineFilter;'
  )(engineFilter)
  return { guard, current: engineFilter }
}

describe('restoring the engine version filter', () => {
  it('survives the first load, when custom engine versions are still being resolved', () => {
    const { guard, current } = buildEngineGuard('5.8')
    guard([[{ value: '' }, { value: 'N/A' }], false])
    expect(current.value).toBe('5.8')
  })

  it('clears once that version is really gone from the library', () => {
    const { guard, current } = buildEngineGuard('5.8')
    guard([[{ value: '' }, { value: '5.5' }], true])
    expect(current.value).toBe('')
  })
})

describe('project section group filter', () => {
  it('shows grouped projects under 全部 too', () => {
    const visible = buildBaseProjects('__all__')
    expect(visible.value.map((p: Project) => p.projectKey)).toEqual(['a', 'b'])
  })

  it('keeps only that group when one is picked', () => {
    const visible = buildBaseProjects('col-1')
    expect(visible.value.map((p: Project) => p.projectKey)).toEqual(['a'])
  })

  it('leaves grouped projects out of 未分组', () => {
    const visible = buildBaseProjects('__ungrouped__')
    expect(visible.value.map((p: Project) => p.projectKey)).toEqual(['b'])
  })

  it('stacks search on top of the picked group instead of replacing it', () => {
    const visible = buildBaseProjects('col-1', [loose])
    expect(visible.value).toEqual([])
  })
})
