import { mount, type VueWrapper } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import LibraryListTable from './LibraryListTable.vue'

const COLUMNS = ['名称', '类型', '引擎版本', '统计', '标签']

function mountTable(props: Record<string, unknown> = {}, rows = ''): VueWrapper {
  return mount(LibraryListTable, {
    props: { columns: COLUMNS, emptyText: '没有找到匹配的蓝图', isEmpty: false, ...props },
    slots: { default: rows }
  })
}

describe('LibraryListTable', () => {
  it('按传入顺序渲染表头，并补一列空的操作列', () => {
    const wrapper = mountTable()
    const header = wrapper.find('.list-header-row')

    expect(header.findAll('span').map((s) => s.text())).toEqual([...COLUMNS, ''])
    expect(header.find('.col-actions').exists()).toBe(true)
  })

  it('行内容原样渲染在表头之后', () => {
    const wrapper = mountTable(
      {},
      '<div class="list-row"><span class="col-name">BP_Door</span></div>'
    )

    expect(wrapper.find('.list-row .col-name').text()).toBe('BP_Door')
    expect(wrapper.find('.list-empty').exists()).toBe(false)
  })

  it('isEmpty 时显示空文案', () => {
    const wrapper = mountTable({ isEmpty: true })
    expect(wrapper.find('.list-empty').text()).toBe('没有找到匹配的蓝图')
  })

  /**
   * 表头按下标取列宽、数据行按语义类名取，两套必须一一对应 ——
   * 少一个类名那一列就会塌成 flex 默认宽度，整张表歪掉。
   * 这条守的是「列数与列名对得上」。
   */
  it('表头列数与数据行的语义列名数量一致', () => {
    const rowColumns = ['col-name', 'col-type', 'col-aux', 'col-stats', 'col-extra']
    expect(rowColumns).toHaveLength(COLUMNS.length)

    const wrapper = mountTable(
      {},
      `<div class="list-row">${rowColumns.map((c) => `<span class="${c}"></span>`).join('')}<span class="col-actions"></span></div>`
    )

    const headerCells = wrapper.find('.list-header-row').findAll('span').length
    const rowCells = wrapper.find('.list-row').findAll('span').length
    expect(rowCells).toBe(headerCells)
  })
})
