import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useImportTasksStore, type ImportTask } from './importTasks'

const makeTask = (overrides: Partial<ImportTask> = {}): ImportTask => ({
  id: 't1',
  type: 'folder',
  name: '导入 500 个资产',
  progress: 0,
  stageText: '正在准备导入…',
  status: 'running',
  ...overrides
})

describe('importTasks store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('增删改都落在 store 上，跨页面读得到', () => {
    const store = useImportTasksStore()

    store.addTask(makeTask())
    expect(store.hasTask('t1')).toBe(true)

    store.updateTask('t1', { progress: 42, stageText: '正在导入 210/500' })
    expect(store.allTasks[0].progress).toBe(42)
    expect(store.allTasks[0].stageText).toBe('正在导入 210/500')

    store.removeTask('t1')
    expect(store.allTasks).toEqual([])
  })

  it('更新一个不存在的任务不会凭空建出来', () => {
    const store = useImportTasksStore()

    store.updateTask('ghost', { progress: 90 })

    expect(store.allTasks).toEqual([])
  })

  it('跑完的任务不进 runningTasks —— 挂件不该堆完成项', () => {
    const store = useImportTasksStore()
    store.addTask(makeTask({ id: 'running', progress: 30 }))
    store.addTask(makeTask({ id: 'done', status: 'completed', progress: 100 }))
    store.addTask(makeTask({ id: 'full', progress: 100 }))

    expect(store.runningTasks().map((t) => t.id)).toEqual(['running'])
  })

  it('按保管库隔离，别的库的任务不显示', () => {
    const store = useImportTasksStore()
    store.addTask(makeTask({ id: 'mine', vaultId: 'vault_a' }))
    store.addTask(makeTask({ id: 'other', vaultId: 'vault_b' }))
    // 没记保管库的任务（例如工程导入）任何库下都要看得到
    store.addTask(makeTask({ id: 'anywhere' }))

    expect(store.runningTasks('vault_a').map((t) => t.id)).toEqual(['mine', 'anywhere'])
  })

  it('不传保管库时全都算数', () => {
    const store = useImportTasksStore()
    store.addTask(makeTask({ id: 'mine', vaultId: 'vault_a' }))
    store.addTask(makeTask({ id: 'other', vaultId: 'vault_b' }))

    expect(store.runningTasks().map((t) => t.id)).toEqual(['mine', 'other'])
  })

  it('失败的任务不许跟着消失 —— 它才是最该被看见的那一条', () => {
    const store = useImportTasksStore()
    // 原来这里只按「跑完了就不显示」过滤，失败的任务 progress 也是 100，
    // 于是导入一失败就从挂件上消失，用户唯一看得到的是一句一闪而过的 toast
    store.addTask(makeTask({ id: 'failed', status: 'error', progress: 100 }))
    store.addTask(makeTask({ id: 'done', status: 'completed', progress: 100 }))

    expect(store.runningTasks().map((t) => t.id)).toEqual(['failed'])
  })

  it('当前文件夹里的任务照样要显示 —— 这正是原来看不到进度的原因', () => {
    const store = useImportTasksStore()
    store.addTask(makeTask({ id: 'here', folderKey: 'folder_a' }))
    store.addTask(makeTask({ id: 'there', folderKey: 'folder_b' }))

    // store 不做「在不在当前视图」的过滤，那是挂件挂在页面里时代的遗留
    expect(store.runningTasks().map((t) => t.id)).toEqual(['here', 'there'])
  })
})
