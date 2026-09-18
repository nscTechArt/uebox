import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Checkbox } from 'ant-design-vue'
import { createI18n } from 'vue-i18n'
import zhCN from '@renderer/i18n/locales/zh-CN'
import type {
  LegacyImportPreview,
  LegacyImportReport,
  LegacyScanResult
} from '../services/legacyImport'

const scanLegacyDb = vi.fn<() => Promise<LegacyScanResult>>()
const selectLegacyDb = vi.fn<() => Promise<string | null>>()

vi.mock('../services/legacyImport', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  scanLegacyDb: () => scanLegacyDb(),
  selectLegacyDb: () => selectLegacyDb()
}))

const LibraryMigrationWizard = (await import('./LibraryMigrationWizard.vue')).default

const DB = { path: 'C:/legacy/uebox.db', userId: 'user-1', sizeKB: 128 }

const PREVIEW: LegacyImportPreview = {
  entries: [
    { id: '1', name: 'BP_Door', type: '蓝图函数', folderKey: 'f1' },
    { id: '2', name: 'BP_Chest', type: '蓝图函数', folderKey: 'f2' },
    // 不属于任何文件夹 —— 全不选时它仍然算数
    { id: '3', name: 'BP_Loose', type: '蓝图函数', folderKey: '' }
  ],
  folders: [
    { folderKey: 'f1', title: '门', entryCount: 1 },
    { folderKey: 'f2', title: '箱子', entryCount: 1 }
  ],
  totalSkipped: 4
}

const REPORT: LegacyImportReport = { total: 3, imported: 3, skipped: 0, collections: 1 }

const preview = vi.fn()
const execute = vi.fn()

async function mountWizard(): Promise<VueWrapper> {
  const wrapper = mount(LibraryMigrationWizard, {
    props: { i18nPrefix: 'blueprintMigration', service: { preview, execute } },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } })],
      // 文件夹勾选用的是 ant 的 Checkbox。真实应用里 main.ts 全局 app.use(Antd)，
      // 测试没装插件的话它会当成未知标签渲染 —— 类名还在，里面的 input 没有
      components: { ACheckbox: Checkbox },
      // 挂在 LibraryFormModal 里，那个组件 Teleport 到 body
      stubs: { teleport: true }
    }
  })
  await flushPromises()
  return wrapper
}

describe('LibraryMigrationWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    scanLegacyDb.mockResolvedValue({ found: true, dbPaths: [DB] })
    preview.mockResolvedValue(PREVIEW)
    execute.mockResolvedValue(REPORT)
  })

  /**
   * 扫描是程序该自己干的事，不是一个要用户点「下一步」的步骤。
   * 打开就应该找完库、读完预览、全选好，第一屏直接是「导入吗」。
   */
  it('打开就自动扫描 + 读预览 + 全选，不让用户走步骤', async () => {
    const wrapper = await mountWizard()

    expect(scanLegacyDb).toHaveBeenCalledTimes(1)
    expect(preview).toHaveBeenCalledWith(DB.path)
    expect(wrapper.find('.summary-count').text()).toBe('3')
    expect(wrapper.find('.steps-bar').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('下一步')
  })

  it('细节默认收起，展开「自定义」才出现文件夹', async () => {
    const wrapper = await mountWizard()
    const body = (): HTMLElement => wrapper.find('.customize-body').element as HTMLElement

    expect(body().style.display).toBe('none')

    await wrapper.find('.customize-toggle').trigger('click')
    expect(body().style.display).not.toBe('none')
    expect(wrapper.findAll('.folder-item')).toHaveLength(2)
  })

  it('主按钮直接说要导入几个，标题走领域前缀', async () => {
    const wrapper = await mountWizard()

    expect(wrapper.find('.btn-confirm').text()).toBe('导入 3 个')
    expect(wrapper.find('.modal-title').text()).toBe('从旧版导入蓝图')
    expect(wrapper.find('.summary-unit').text()).toBe('个蓝图可以导入')
  })

  it('勾掉文件夹后数字与按钮跟着变', async () => {
    const wrapper = await mountWizard()
    await wrapper.find('.customize-toggle').trigger('click')
    // AppCheckbox 画的是 <button role="checkbox">，不是 antd 那个内嵌的 <input>
    await wrapper.findAll('.folder-item .app-checkbox__box')[0].trigger('click')

    expect(wrapper.find('.summary-count').text()).toBe('2')
    expect(wrapper.find('.btn-confirm').text()).toBe('导入 2 个')
  })

  /**
   * execute 的实现里 `null` 曾表示「不按文件夹过滤」也就是全导入，
   * 而全不选时传的正是 null —— 用户点「全不选」反而把整个旧库搬了进来。
   */
  it('全不选时传空 Set，而不是「不过滤」的 null', async () => {
    const wrapper = await mountWizard()
    await wrapper.find('.customize-toggle').trigger('click')
    await wrapper.find('.btn-toggle-all').trigger('click')

    await wrapper.find('.btn-confirm').trigger('click')
    await flushPromises()

    const folderArg = execute.mock.calls[0][1]
    expect(folderArg).toBeInstanceOf(Set)
    expect(folderArg.size).toBe(0)
  })

  // ===== 0 的时候必须说清楚为什么 =====

  it('已全部导入过：说是去重跳过的，不是空的', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      entries: PREVIEW.entries.map((e) => ({ ...e, exists: true }))
    })
    const wrapper = await mountWizard()

    expect(wrapper.find('.summary-count').text()).toBe('0')
    expect(wrapper.find('.summary-sub').text()).toContain('都已经在库里了')
    expect((wrapper.find('.btn-confirm').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('文件里一条都没有：说这个文件没有', async () => {
    preview.mockResolvedValue({ entries: [], folders: [], totalSkipped: 0 })
    const wrapper = await mountWizard()

    expect(wrapper.find('.summary-sub').text()).toBe('这个文件里没有蓝图。')
  })

  it('文件里全是另一类节点：说清楚该去哪个库导', async () => {
    preview.mockResolvedValue({ entries: [], folders: [], totalSkipped: 12 })
    const wrapper = await mountWizard()

    expect(wrapper.find('.summary-sub').text()).toContain('12 个节点都不是蓝图')
    expect(wrapper.find('.summary-sub').text()).toContain('材质库')
  })

  it('自己把文件夹全取消了：提示去勾选，而不是说没有数据', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      // 全部都有归属，全不选后就真的一个不剩
      entries: PREVIEW.entries.filter((e) => e.folderKey)
    })
    const wrapper = await mountWizard()
    await wrapper.find('.customize-toggle').trigger('click')
    await wrapper.find('.btn-toggle-all').trigger('click')

    expect(wrapper.find('.summary-count').text()).toBe('0')
    expect(wrapper.find('.summary-sub').text()).toContain('一个文件夹都没勾选')
  })

  it('部分已存在时在副标题里说一句', async () => {
    preview.mockResolvedValue({
      ...PREVIEW,
      entries: [{ ...PREVIEW.entries[0], exists: true }, ...PREVIEW.entries.slice(1)]
    })
    const wrapper = await mountWizard()

    expect(wrapper.find('.summary-count').text()).toBe('2')
    expect(wrapper.find('.summary-sub').text()).toContain('1 个已在库中，会跳过')
  })

  // ===== 结果与失败 =====

  it('导入完成后给一句话结果，点完成把报告发出去', async () => {
    const wrapper = await mountWizard()

    await wrapper.find('.btn-confirm').trigger('click')
    await flushPromises()

    expect(wrapper.find('.done-title').text()).toBe('已导入 3 个蓝图')
    expect(wrapper.find('.done-sub').text()).toContain('创建了 1 个集合')

    await wrapper.find('.btn-confirm').trigger('click')
    expect(wrapper.emitted('done')).toEqual([[REPORT]])
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('没扫到旧库时只给一个动作：选文件', async () => {
    scanLegacyDb.mockResolvedValue({ found: false, dbPaths: [] })
    const wrapper = await mountWizard()

    expect(wrapper.find('.wizard-empty').exists()).toBe(true)
    expect(preview).not.toHaveBeenCalled()
  })

  it('手动选完文件直接读预览，不再多一步', async () => {
    scanLegacyDb.mockResolvedValue({ found: false, dbPaths: [] })
    selectLegacyDb.mockResolvedValue('D:/other.db')
    const wrapper = await mountWizard()

    await wrapper.find('.btn-pick-file').trigger('click')
    await flushPromises()

    expect(preview).toHaveBeenCalledWith('D:/other.db')
    expect(wrapper.find('.wizard-confirm').exists()).toBe(true)
  })

  /**
   * 三处失败以前都只 console.error：预览失败时点「下一步」毫无反应，
   * 导入失败时只剩一个「完成」按钮，看起来像成功了。
   */
  it('扫描失败时说得出原因，并退回选文件', async () => {
    scanLegacyDb.mockRejectedValue(new Error('数据库被占用'))
    const wrapper = await mountWizard()

    expect(wrapper.find('.wizard-error').text()).toContain('数据库被占用')
    expect(wrapper.find('.wizard-empty').exists()).toBe(true)
  })

  it('导入失败时退回确认屏并报错，不显示成功', async () => {
    execute.mockRejectedValue(new Error('磁盘满了'))
    const wrapper = await mountWizard()

    await wrapper.find('.btn-confirm').trigger('click')
    await flushPromises()

    expect(wrapper.find('.wizard-error').text()).toContain('磁盘满了')
    expect(wrapper.find('.wizard-done').exists()).toBe(false)
    expect(wrapper.find('.wizard-confirm').exists()).toBe(true)
  })
})
