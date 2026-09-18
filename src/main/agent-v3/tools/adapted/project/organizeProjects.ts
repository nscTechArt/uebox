/**
 * 工程库的分组（合集）和置顶。
 *
 * ## 为什么补
 *
 * agent 能列工程、能建工程、能开工程，唯独**整理不了工程库**。用户说
 * 「按虚幻版本把我的工程分个组」，它只能把分组方案讲出来，然后请用户自己
 * 去首页一个个拖。合集表、置顶位都在数据库里躺着，界面用得好好的，
 * 只有 agent 够不着 —— 这是「工具比后端窄」的典型。
 *
 * ## 一个工程可以同时在多个合集里
 *
 * 成员关系在 `project_collection_items` 关联表里。加进 B 合集不会把它从 A
 * 里拿出来 —— 用户按引擎版本分一遍、再按用途分一遍，两套分组能同时成立。
 * 移出某一个合集要点名是哪一个，不点名就是从所有合集里移出去。
 *
 * ## 建合集和装工程是一个动作
 *
 * `group_projects` 里合集不存在就顺手建。空合集在首页上是看得见的
 * （一颗计数为 0 的筛选按钮），所以只建一个空合集也是允许的 ——
 * 界面上用户自己就能这么干，工具不该比它窄。
 *
 * ## 三件事故意不做
 *
 * - **合集的 color / icon / description**：三列在数据库里有，但渲染层一处都没读
 *   （首页的合集卡片只用 name 和封面缩略图）。给了模型就等于让它
 *   汇报一件用户验证不了的事 —— 「已经把合集设成蓝色」而界面纹丝不动，
 *   比没有这个能力更糟。哪天界面开始渲染了，再在这里补上。
 * - **sort_order**：这一列是首页拖拽排序的产物，值是「置顶组内 / 普通组内」的下标，
 *   每拖一次整组重排。模型只改一个工程而不重排同组其余的，会得到一堆并列的 0，
 *   顺序反而更不稳定。用户嘴里的「排前面」是置顶，那个在这里是完整的。
 * - **删工程**：`delete_collection` 只拆分组，工程一个都不少。从库里移除工程是
 *   另一件事，不该藏在「整理」这个动作后面。
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { defineV2Tool, type V2Tool } from '../../adaptV2Tool'
import { getAppWindows } from '../../../../appWindows'
import { getPublicDatabase } from '../../../../sqliteDataBase'
import {
  getAllProjects,
  getProjectByKey,
  updateProject,
  type ProjectRecord
} from '../../../../sqliteDataBase/models/project'
import {
  assignProjectToCollection,
  clearProjectsOfCollection,
  createProjectCollection,
  deleteProjectCollectionByKey,
  getAllProjectCollections,
  getCollectionKeysOfProject,
  getProjectCollectionByKey,
  getProjectsByCollectionKey,
  isProjectInCollection,
  removeProjectFromCollection,
  updateProjectCollection,
  type ProjectCollectionRecord
} from '../../../../sqliteDataBase/models/projectCollection'

/** 界面上新建分组用的 key 前缀（`CollectionNameModal.vue`），这里保持一致 */
const COLLECTION_KEY_PREFIX = 'collection_'

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * 告诉首页「我的项目」重读一遍。
 *
 * 用的是 `db:project:library-changed` —— 首页收到它会同时重拉工程和合集
 * （`refreshProjectSectionData`），正好覆盖这个工具能改的全部东西。
 * 不推的话，分组明明写进库了，用户得切个页面才看得见，会认为 agent 在撒谎。
 */
function notifyLibraryChanged(): void {
  for (const win of getAppWindows()) {
    win.webContents.send('db:project:library-changed')
  }
}

const collectionLabel = (record: ProjectCollectionRecord): string =>
  (record.name ?? '').trim() || record.collectionKey

interface CollectionLookup {
  record?: ProjectCollectionRecord
  /** 认不准（重名、或给了一个不存在的 collectionKey）时的原话 */
  error?: string
}

/**
 * 把模型给的说法对到一个合集上：collectionKey 或合集名都认。
 *
 * 重名不自己挑 —— 和素材库文件夹一个规矩，列出候选让模型去问用户。
 */
function resolveCollection(
  db: ReturnType<typeof getPublicDatabase>,
  ref: string
): CollectionLookup {
  const needle = String(ref ?? '').trim()
  if (!needle) return { error: '没有给出合集（collection 参数为空）。' }

  const byKey = getProjectCollectionByKey(db, needle)
  if (byKey) return { record: byKey }

  // 看着像 key 却查不到，多半是抄错了一个 key，而不是想用它当名字建新合集
  if (needle.startsWith(COLLECTION_KEY_PREFIX)) {
    return {
      error: `没有 collectionKey 为「${needle}」的合集。用 project_list 的 collections 查。`
    }
  }

  const lowered = needle.toLowerCase()
  const byName = getAllProjectCollections(db).filter(
    (c) => (c.name ?? '').trim().toLowerCase() === lowered
  )
  if (byName.length === 1) return { record: byName[0] }
  if (byName.length > 1) {
    return {
      error:
        `有 ${byName.length} 个合集都叫「${needle}」：` +
        `${byName.map((c) => c.collectionKey).join('、')}。` +
        '用 collectionKey 点名要哪一个 —— 这个得问用户，不要自己挑。'
    }
  }

  return {}
}

interface ProjectLookup {
  resolved: ProjectRecord[]
  errors: string[]
}

/**
 * 把模型给的一串说法对到具体工程上：projectKey 优先，其次是工程名。
 *
 * 整批解析，有一个认不准就整批不动：分错组本身不难恢复，但「一半成一半没成」
 * 的返回值会让模型接着往下猜，用户更看不懂发生了什么。
 */
function resolveProjects(all: ProjectRecord[], refs: string[]): ProjectLookup {
  const byKey = new Map(all.map((p) => [p.projectKey, p]))
  const resolved: ProjectRecord[] = []
  const errors: string[] = []
  const seen = new Set<string>()

  for (const raw of refs) {
    const needle = String(raw ?? '').trim()
    if (!needle) continue

    const hit = byKey.get(needle)
    if (hit) {
      if (!seen.has(hit.projectKey)) {
        seen.add(hit.projectKey)
        resolved.push(hit)
      }
      continue
    }

    const lowered = needle.toLowerCase()
    const byName = all.filter((p) => (p.projectName ?? '').trim().toLowerCase() === lowered)
    if (byName.length === 1) {
      if (!seen.has(byName[0].projectKey)) {
        seen.add(byName[0].projectKey)
        resolved.push(byName[0])
      }
      continue
    }
    if (byName.length > 1) {
      errors.push(
        `有 ${byName.length} 个工程都叫「${needle}」：` +
          `${byName.map((p) => p.projectKey).join('、')}。用 projectKey 点名。`
      )
      continue
    }

    errors.push(`项目库里没有「${needle}」这个工程（既不是 projectKey 也不是工程名）。`)
  }

  return { resolved, errors }
}

interface MoveOutcome {
  project: string
  projectKey: string
  status: 'moved' | 'unchanged' | 'failed' | 'unconfirmed'
  /** 这次从哪几个合集里出来了（ungroup_projects 用） */
  left_collections?: string[]
  reason?: string
}

export function createOrganizeProjectsTool(): V2Tool {
  return defineV2Tool({
    description: `整理「我的项目」：把工程分到合集里、置顶工程、改合集名字。

【action 取值】
- group_projects：把一批工程放进一个合集。**合集不存在就顺手建**（collection 填合集名即可），
  已存在就直接往里加。按引擎版本分组就是每个版本调一次。
  不给 projects 就是只建一个空合集，用户随后自己往里拖
- ungroup_projects：把一批工程移出合集。给了 collection 就只移出那一个合集，
  不给就是从所有合集里移出去（工程还在库里，只是不分组了）
- pin_projects：置顶 / 取消置顶工程，置顶的排在首页最前面
- update_collection：改合集名字、置顶合集
- delete_collection：解散合集。**里面的工程一个都不会删**，只是回到未分组状态

【一个工程可以同时在多个合集里】加进 B 不会把它从 A 里拿出来 —— 按版本分一遍、
再按用途分一遍，两套分组能并存。要把它从某个合集里拿出来，用 ungroup_projects 点名那个合集。

【怎么指定工程】projects 填 projectKey（project_list 的 list_projects 里查）或工程名。
重名的工程会报错并列出候选 —— 那时要问用户，不要自己挑。合集同理，collection 填
合集名或 collectionKey。

【现在是怎么分的】project_list 的 list_projects 会一起返回 collections（含空合集）
和每个工程的 collections / pinned，先看一眼再动手，别把已经分好的又搬一遍。

【改完界面立刻会变】首页会收到通知自己重读，不用请用户刷新或重启。

【颜色和描述改不了】合集表里有这几列，但界面一处都没渲染，改了用户看不见，
所以这里没给 —— 用户要合集「换个颜色」时如实说做不到，别去改一个不显示的字段。`,

    inputSchema: z.object({
      action: z
        .enum([
          'group_projects',
          'ungroup_projects',
          'pin_projects',
          'update_collection',
          'delete_collection'
        ])
        .describe(
          '【必填】group_projects 分组 / ungroup_projects 移出合集 / pin_projects 置顶工程 / ' +
            'update_collection 改合集（改名、置顶）/ delete_collection 解散合集'
        ),
      collection: z
        .string()
        .optional()
        .describe(
          '合集：合集名或 collectionKey。group_projects 时这个合集不存在就按这个名字新建；' +
            'ungroup_projects 时是「只移出这一个合集」，不给就是移出所有合集；' +
            'update_collection / delete_collection 必须指向已有合集'
        ),
      projects: z
        .array(z.string())
        .optional()
        .describe(
          '工程列表：projectKey（来自 project_list）或工程名。' +
            'ungroup_projects / pin_projects 需要它；group_projects 不给就是只建一个空合集'
        ),
      newName: z.string().optional().describe('合集的新名字（仅 update_collection）'),
      pinned: z
        .boolean()
        .optional()
        .describe(
          'pin_projects：true 置顶这些工程，false 取消置顶，默认 true。' +
            'update_collection：true/false 置顶或取消置顶这个合集'
        )
    }),

    execute: async (input) => {
      const db = getPublicDatabase()

      try {
        switch (input.action) {
          case 'group_projects':
            return groupProjects(db, input.collection, input.projects)
          case 'ungroup_projects':
            return ungroupProjects(db, input.projects, input.collection)
          case 'pin_projects':
            return pinProjects(db, input.projects, input.pinned ?? true)
          case 'update_collection':
            return updateCollection(db, input.collection, input.newName, input.pinned)
          case 'delete_collection':
            return deleteCollection(db, input.collection)
          default:
            return {
              success: false,
              error:
                `未知操作: ${String(input.action)}。有效操作: group_projects、ungroup_projects、` +
                'pin_projects、update_collection、delete_collection'
            }
        }
      } catch (error) {
        return { success: false, error: errText(error) }
      }
    }
  })
}

type Db = ReturnType<typeof getPublicDatabase>

function groupProjects(
  db: Db,
  collectionRef: string | undefined,
  projectRefs: string[] | undefined
): Record<string, unknown> {
  const name = String(collectionRef ?? '').trim()
  if (!name) return { success: false, error: '需要 collection 参数（合集名或 collectionKey）。' }

  const lookup = resolveProjects(getAllProjects(db), projectRefs ?? [])
  if (lookup.errors.length > 0) {
    return { success: false, error: lookup.errors.join(' '), moved_count: 0 }
  }

  const found = resolveCollection(db, name)
  if (found.error) return { success: false, error: found.error }

  let collection = found.record
  let created = false
  if (!collection) {
    const collectionKey = `${COLLECTION_KEY_PREFIX}${randomUUID()}`
    try {
      createProjectCollection(db, { collectionKey, name, sort_order: 0, isPinned: 0 })
    } catch (error) {
      return { success: false, error: `建合集「${name}」失败：${errText(error)}` }
    }
    // 回读校验：建完查不到就不算建成，宁可报没确认上
    collection = getProjectCollectionByKey(db, collectionKey)
    if (!collection) {
      return {
        success: false,
        error: `建合集的命令跑完了，但回读时查不到「${name}」—— 没有确认建成功。`
      }
    }
    created = true
  }

  const targetKey = collection.collectionKey
  const results: MoveOutcome[] = []

  for (const project of lookup.resolved) {
    const label = (project.projectName ?? '').trim() || project.projectKey

    if (isProjectInCollection(db, project.projectKey, targetKey)) {
      results.push({ project: label, projectKey: project.projectKey, status: 'unchanged' })
      continue
    }

    try {
      assignProjectToCollection(db, project.projectKey, targetKey)
    } catch (error) {
      results.push({
        project: label,
        projectKey: project.projectKey,
        status: 'failed',
        reason: errText(error)
      })
      continue
    }

    // 回读校验：写完查不到这条归属就不算加进去了
    if (!isProjectInCollection(db, project.projectKey, targetKey)) {
      results.push({
        project: label,
        projectKey: project.projectKey,
        status: 'unconfirmed',
        reason: '写入命令跑完了，但回读时它还不在这个合集里 —— 没有确认加进去'
      })
      continue
    }

    results.push({ project: label, projectKey: project.projectKey, status: 'moved' })
  }

  const moved = results.filter((r) => r.status === 'moved')
  const unchanged = results.filter((r) => r.status === 'unchanged')
  if (moved.length > 0 || created) notifyLibraryChanged()

  return {
    success: moved.length + unchanged.length === results.length,
    message:
      `${created ? '已新建合集' : '已使用已有合集'}「${collectionLabel(collection)}」，` +
      (results.length === 0
        ? '还没往里放工程 —— 它在首页上是一颗计数为 0 的分组按钮，可以把工程拖进去'
        : `放进 ${moved.length}/${results.length} 个工程` +
          (unchanged.length > 0 ? `（${unchanged.length} 个本来就在里面）` : '') +
          '。这些工程原来所在的合集都还在，一个工程可以同时属于多个合集'),
    collectionKey: targetKey,
    collection: collectionLabel(collection),
    created,
    moved_count: moved.length,
    results
  }
}

function ungroupProjects(
  db: Db,
  projectRefs: string[] | undefined,
  collectionRef: string | undefined
): Record<string, unknown> {
  if (!projectRefs || projectRefs.length === 0) {
    return { success: false, error: '需要 projects 参数（至少一个工程）。' }
  }

  // 点名了某个合集就只移出那一个，不点名就是从所有合集里移出去
  let target: ProjectCollectionRecord | undefined
  if (String(collectionRef ?? '').trim()) {
    const found = resolveCollection(db, String(collectionRef))
    if (found.error) return { success: false, error: found.error }
    if (!found.record) {
      return {
        success: false,
        error: `没有叫「${String(collectionRef).trim()}」的合集。用 project_list 的 collections 查现有合集。`
      }
    }
    target = found.record
  }

  const lookup = resolveProjects(getAllProjects(db), projectRefs)
  if (lookup.errors.length > 0) {
    return { success: false, error: lookup.errors.join(' '), removed_count: 0 }
  }

  const labelOf = (key: string): string =>
    collectionLabel(getProjectCollectionByKey(db, key) ?? { collectionKey: key, name: key })

  const results: MoveOutcome[] = []
  for (const project of lookup.resolved) {
    const label = (project.projectName ?? '').trim() || project.projectKey
    const before = getCollectionKeysOfProject(db, project.projectKey)
    const leaving = target ? before.filter((key) => key === target.collectionKey) : before

    if (leaving.length === 0) {
      results.push({ project: label, projectKey: project.projectKey, status: 'unchanged' })
      continue
    }

    try {
      removeProjectFromCollection(db, project.projectKey, target?.collectionKey)
    } catch (error) {
      results.push({
        project: label,
        projectKey: project.projectKey,
        status: 'failed',
        reason: errText(error)
      })
      continue
    }

    const after = new Set(getCollectionKeysOfProject(db, project.projectKey))
    if (leaving.some((key) => after.has(key))) {
      results.push({
        project: label,
        projectKey: project.projectKey,
        status: 'unconfirmed',
        reason: '移出命令跑完了，但回读时它还挂在原来的合集上 —— 没有确认移出'
      })
      continue
    }

    results.push({
      project: label,
      projectKey: project.projectKey,
      status: 'moved',
      left_collections: leaving.map(labelOf)
    })
  }

  const removed = results.filter((r) => r.status === 'moved')
  const unchanged = results.filter((r) => r.status === 'unchanged')
  if (removed.length > 0) notifyLibraryChanged()

  const scope = target ? `合集「${collectionLabel(target)}」` : '所在的全部合集'
  return {
    success: removed.length + unchanged.length === results.length,
    message:
      `已把 ${removed.length}/${results.length} 个工程移出${scope}（工程还在库里，只是不分组了）` +
      (unchanged.length > 0 ? `，${unchanged.length} 个本来就不在里面` : ''),
    removed_count: removed.length,
    results
  }
}

function pinProjects(
  db: Db,
  projectRefs: string[] | undefined,
  pinned: boolean
): Record<string, unknown> {
  if (!projectRefs || projectRefs.length === 0) {
    return { success: false, error: '需要 projects 参数（至少一个工程）。' }
  }

  const lookup = resolveProjects(getAllProjects(db), projectRefs)
  if (lookup.errors.length > 0) {
    return { success: false, error: lookup.errors.join(' '), pinned_count: 0 }
  }

  const want = pinned ? 1 : 0
  const results: Array<{
    project: string
    projectKey: string
    status: 'changed' | 'unchanged' | 'failed' | 'unconfirmed'
    reason?: string
  }> = []

  for (const project of lookup.resolved) {
    const label = (project.projectName ?? '').trim() || project.projectKey
    if (Number(project.isPinned ?? 0) === want) {
      results.push({ project: label, projectKey: project.projectKey, status: 'unchanged' })
      continue
    }

    try {
      updateProject(db, project.projectKey, { isPinned: want })
    } catch (error) {
      results.push({
        project: label,
        projectKey: project.projectKey,
        status: 'failed',
        reason: errText(error)
      })
      continue
    }

    if (Number(getProjectByKey(db, project.projectKey)?.isPinned ?? 0) !== want) {
      results.push({
        project: label,
        projectKey: project.projectKey,
        status: 'unconfirmed',
        reason: `${pinned ? '置顶' : '取消置顶'}命令跑完了，但回读时状态没变 —— 没有确认改成功`
      })
      continue
    }

    results.push({ project: label, projectKey: project.projectKey, status: 'changed' })
  }

  const changed = results.filter((r) => r.status === 'changed')
  const unchanged = results.filter((r) => r.status === 'unchanged')
  if (changed.length > 0) notifyLibraryChanged()

  return {
    success: changed.length + unchanged.length === results.length,
    message:
      `已${pinned ? '置顶' : '取消置顶'} ${changed.length}/${results.length} 个工程` +
      (unchanged.length > 0 ? `（${unchanged.length} 个本来就是这个状态）` : ''),
    pinned_count: changed.length,
    results
  }
}

function updateCollection(
  db: Db,
  collectionRef: string | undefined,
  newName: string | undefined,
  pinned: boolean | undefined
): Record<string, unknown> {
  const found = resolveCollection(db, String(collectionRef ?? ''))
  if (found.error) return { success: false, error: found.error }
  if (!found.record) {
    return {
      success: false,
      error: `没有叫「${String(collectionRef ?? '').trim()}」的合集。用 project_list 的 collections 查现有合集。`
    }
  }

  const name = newName === undefined ? undefined : String(newName).trim()
  if (name !== undefined && !name) return { success: false, error: '新名字不能为空。' }
  if (name === undefined && pinned === undefined) {
    return { success: false, error: '没有要改的东西：给 newName（改名）或 pinned（置顶）。' }
  }

  const key = found.record.collectionKey
  const before = collectionLabel(found.record)

  try {
    updateProjectCollection(db, key, {
      ...(name !== undefined ? { name } : {}),
      ...(pinned !== undefined ? { isPinned: pinned ? 1 : 0 } : {})
    })
  } catch (error) {
    return { success: false, error: `改合集失败：${errText(error)}` }
  }

  // 回读校验
  const after = getProjectCollectionByKey(db, key)
  if (!after) {
    return { success: false, error: '改完回读时查不到这个合集了 —— 没有确认改成功。' }
  }
  if (name !== undefined && (after.name ?? '').trim() !== name) {
    return {
      success: false,
      error: `改名命令跑完了，但回读时它还叫「${collectionLabel(after)}」—— 没有确认改成功。`
    }
  }
  if (pinned !== undefined && Number(after.isPinned ?? 0) !== (pinned ? 1 : 0)) {
    return {
      success: false,
      error: `${pinned ? '置顶' : '取消置顶'}命令跑完了，但回读时状态没变 —— 没有确认改成功。`
    }
  }

  notifyLibraryChanged()

  const changes: string[] = []
  if (name !== undefined) changes.push(`改名为「${name}」`)
  if (pinned !== undefined) changes.push(pinned ? '已置顶' : '已取消置顶')

  return {
    success: true,
    message: `合集「${before}」${changes.join('，')}`,
    collectionKey: key,
    collection: collectionLabel(after)
  }
}

function deleteCollection(db: Db, collectionRef: string | undefined): Record<string, unknown> {
  const found = resolveCollection(db, String(collectionRef ?? ''))
  if (found.error) return { success: false, error: found.error }
  if (!found.record) {
    return {
      success: false,
      error: `没有叫「${String(collectionRef ?? '').trim()}」的合集。用 project_list 的 collections 查现有合集。`
    }
  }

  const key = found.record.collectionKey
  const label = collectionLabel(found.record)
  // 先数一遍要放出来多少工程 —— 用户听到的不能只是「合集删了」
  const members = getProjectsByCollectionKey(db, key).length

  try {
    clearProjectsOfCollection(db, key)
    deleteProjectCollectionByKey(db, key)
  } catch (error) {
    return { success: false, error: `解散合集失败：${errText(error)}` }
  }

  // 回读校验：查得到就说明没删成
  if (getProjectCollectionByKey(db, key)) {
    return {
      success: false,
      error: `解散命令跑完了，但回读时这个合集还在 —— 没有确认删掉。`
    }
  }

  notifyLibraryChanged()

  return {
    success: true,
    message:
      `合集「${label}」已解散，里面的 ${members} 个工程回到未分组状态 ——` +
      '工程本身一个都没删，还在「我的项目」里',
    collectionKey: key,
    projects_ungrouped: members
  }
}
