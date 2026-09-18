/**
 * 文件夹树自己要钉住的行为：
 *
 *   1. **键盘用户能在树里活** —— 方向键在可见行之间移动、收起的子级被跳过、
 *      左右收展/跳父级；改名弹窗关掉后焦点回到原来的行，不掉进 body。
 *   2. **拖拽落点高亮不闪** —— 在行内子元素之间挪动不算离开，真正出去才清。
 *
 * 挂到 document 上跑：VTU 默认把组件挂进一个游离的 div，游离元素
 * `.focus()` 是无效的，焦点断言会全部落空。文件夹用拉丁名 ——
 * happy-dom 的中文 collation 排序和浏览器不一致，别把断言押在它身上。
 */
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'

import BrowserFolderTree from './BrowserFolderTree.vue'
import type { BrowserFolder } from './types'

const folders: BrowserFolder[] = [
  { key: 'chars', name: 'Actors', parentKey: null },
  { key: 'chars-move', name: 'Movement', parentKey: 'chars' },
  { key: 'props', name: 'Props', parentKey: null }
]

const baseProps = {
  modelValue: '',
  rootLabel: '全部',
  rootCount: 7,
  sectionTitle: '文件夹',
  createTitle: '新建文件夹',
  defaultFolderName: '新建文件夹',
  renameTitle: '重命名',
  deleteTitle: '删除文件夹'
}

let activeWrapper: VueWrapper | null = null

function mountTree(overrides: Partial<typeof baseProps> = {}): VueWrapper {
  activeWrapper = mount(BrowserFolderTree, {
    props: { ...baseProps, folders, counts: { chars: 3 }, ...overrides },
    attachTo: document.body
  })
  return activeWrapper
}

afterEach(() => {
  activeWrapper?.unmount()
  activeWrapper = null
})

function rowButtons(wrapper: VueWrapper): Array<DOMWrapper<Element>> {
  return wrapper.findAll('button.tree-row')
}

/** focus 定义在 HTMLElement 上，行节点拿到的静态类型是 Element —— 收窄一下 */
function focusRow(row: DOMWrapper<Element>): void {
  ;(row.element as HTMLElement).focus()
}

describe('渲染与选择', () => {
  it('根行常驻，子文件夹按名称排序，计数徽标跟在名字后面', () => {
    const wrapper = mountTree()
    expect(wrapper.findAll('.tree-name').map((n) => n.text())).toEqual([
      '全部',
      'Actors',
      'Movement',
      'Props'
    ])
    expect(wrapper.findAll('.tree-count').map((n) => n.text())).toEqual(['7', '3'])
  })

  it('选中的行带 aria-current，根行默认选中', () => {
    const wrapper = mountTree()
    expect(rowButtons(wrapper)[0].attributes('aria-current')).toBe('true')
    expect(rowButtons(wrapper)[1].attributes('aria-current')).toBeUndefined()
  })
})

describe('收起与展开', () => {
  it('箭头收起子级，aria-expanded 同步', async () => {
    const wrapper = mountTree()
    const caret = wrapper.find('button.tree-caret')
    expect(caret.attributes('aria-expanded')).toBe('true')

    await caret.trigger('click')
    expect(caret.attributes('aria-expanded')).toBe('false')
    expect(wrapper.text()).not.toContain('Movement')
  })
})

describe('方向键导航', () => {
  it('上下在可见行之间移动焦点，收起的子级被跳过', async () => {
    const wrapper = mountTree()
    let rows = rowButtons(wrapper)
    focusRow(rows[1])
    await rows[1].trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rowButtons(wrapper)[2].element)

    await wrapper.find('button.tree-caret').trigger('click')
    rows = rowButtons(wrapper)
    focusRow(rows[1])
    await rows[1].trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rowButtons(wrapper)[2].element)
    expect(rowButtons(wrapper)[2].text()).toBe('Props')
  })

  it('右箭头展开收起的文件夹，展开后钻进第一个子级', async () => {
    const wrapper = mountTree()
    await wrapper.find('button.tree-caret').trigger('click')

    const rows = rowButtons(wrapper)
    focusRow(rows[1])
    await rows[1].trigger('keydown', { key: 'ArrowRight' })
    expect(rowButtons(wrapper).map((r) => r.text())).toContain('Movement')

    await rows[1].trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement).toBe(rowButtons(wrapper)[2].element)
    expect(rowButtons(wrapper)[2].text()).toBe('Movement')
  })

  it('左箭头收起展开的文件夹，叶子行退到父级', async () => {
    const wrapper = mountTree()
    let rows = rowButtons(wrapper)
    focusRow(rows[1])
    await rows[1].trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.text()).not.toContain('Movement')

    await wrapper.find('button.tree-caret').trigger('click')
    rows = rowButtons(wrapper)
    focusRow(rows[2])
    await rows[2].trigger('keydown', { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(rowButtons(wrapper)[1].element)
    expect(rowButtons(wrapper)[1].find('.tree-name').text()).toBe('Actors')
  })
})

/*
 * 弹窗 Teleport 到 body，`wrapper.find` 够不着，所以走 document 查。
 * 组件卸载时 Teleport 的内容会跟着清掉，afterEach 不用额外收尾。
 */
function modalInput(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('.modal-body .form-input')
  if (!el) throw new Error('改名弹窗没打开')
  return el
}

function modalButton(text: string): HTMLButtonElement {
  const el = [...document.querySelectorAll<HTMLButtonElement>('.modal-actions button')].find(
    (btn) => btn.textContent?.trim() === text
  )
  if (!el) throw new Error(`弹窗里没有「${text}」按钮`)
  return el
}

async function setModalName(wrapper: VueWrapper, name: string): Promise<void> {
  const input = modalInput()
  input.value = name
  input.dispatchEvent(new Event('input'))
  await wrapper.vm.$nextTick()
}

describe('改名与新建弹窗', () => {
  it('保存后带出 rename-folder，焦点回到那一行', async () => {
    const wrapper = mountTree()
    await wrapper.findAll('.tree-actions button')[0].trigger('click')
    await setModalName(wrapper, '主角')
    modalButton('保存').click()
    await nextTick()
    await nextTick()

    expect(wrapper.emitted('rename-folder')?.[0]).toEqual(['chars', '主角'])
    expect(document.querySelector('.modal-body')).toBeNull()
    expect(document.activeElement).toBe(rowButtons(wrapper)[1].element)
  })

  it('取消不发事件，焦点退回该行', async () => {
    const wrapper = mountTree()
    await wrapper.findAll('.tree-actions button')[0].trigger('click')
    modalButton('取消').click()
    await nextTick()
    await nextTick()

    expect(wrapper.emitted('rename-folder')).toBeUndefined()
    expect(document.querySelector('.modal-body')).toBeNull()
    expect(document.activeElement).toBe(rowButtons(wrapper)[1].element)
  })

  it('名字只剩空格时保存按钮点不动', async () => {
    const wrapper = mountTree()
    await wrapper.findAll('.tree-actions button')[0].trigger('click')
    await setModalName(wrapper, '   ')

    expect(modalButton('保存').disabled).toBe(true)
    modalButton('保存').click()
    await nextTick()
    expect(wrapper.emitted('rename-folder')).toBeUndefined()
  })

  it('弹窗一开就把现有名字选中，省掉一次全选', async () => {
    const wrapper = mountTree()
    await wrapper.findAll('.tree-actions button')[0].trigger('click')
    await nextTick()

    const input = modalInput()
    expect(input.value).toBe('Actors')
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('Actors'.length)
  })

  it('Esc 关掉弹窗，不发事件，焦点退回该行', async () => {
    const wrapper = mountTree()
    await wrapper.findAll('.tree-actions button')[0].trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    await nextTick()

    expect(wrapper.emitted('rename-folder')).toBeUndefined()
    expect(document.querySelector('.modal-body')).toBeNull()
    expect(document.activeElement).toBe(rowButtons(wrapper)[1].element)
  })

  it('新建先建出未命名文件夹，父级回调之后才弹改名', async () => {
    const wrapper = mountTree()
    await wrapper.find('button.section-action').trigger('click')

    const call = wrapper.emitted('create-folder')?.[0] as [string, (key: string) => void]
    expect(call[0]).toBe(baseProps.defaultFolderName)
    // 父级还没回调，弹窗不该出现
    expect(document.querySelector('.modal-body')).toBeNull()

    // 父级建好，把 key 交回来
    await wrapper.setProps({
      folders: [...folders, { key: 'fresh', name: baseProps.defaultFolderName, parentKey: null }]
    })
    call[1]('fresh')
    await nextTick()

    const input = modalInput()
    expect(input.value).toBe(baseProps.defaultFolderName)
    expect(input.selectionEnd).toBe(baseProps.defaultFolderName.length)

    await setModalName(wrapper, '环境')
    modalButton('保存').click()
    await nextTick()
    expect(wrapper.emitted('rename-folder')?.[0]).toEqual(['fresh', '环境'])
  })

  it('新建后取消改名，文件夹仍然留着 —— 只是不发改名事件', async () => {
    const wrapper = mountTree()
    await wrapper.find('button.section-action').trigger('click')
    await wrapper.setProps({
      folders: [...folders, { key: 'fresh', name: baseProps.defaultFolderName, parentKey: null }]
    })
    ;(wrapper.emitted('create-folder')?.[0] as [string, (key: string) => void])[1]('fresh')
    await nextTick()

    modalButton('取消').click()
    await nextTick()
    await nextTick()

    expect(wrapper.emitted('rename-folder')).toBeUndefined()
    expect(wrapper.emitted('delete-folder')).toBeUndefined()
    expect(wrapper.text()).toContain(baseProps.defaultFolderName)
  })

  it('建不出来（父级不回调）就什么也不弹，焦点留在新建按钮上', async () => {
    const wrapper = mountTree()
    const createBtn = wrapper.find('button.section-action')
    ;(createBtn.element as HTMLElement).focus()
    await createBtn.trigger('click')
    await nextTick()

    expect(wrapper.emitted('create-folder')).toHaveLength(1)
    expect(document.querySelector('.modal-body')).toBeNull()
    expect(document.activeElement).toBe(createBtn.element)
  })
})

describe('拖拽落点', () => {
  it('在行内子元素之间挪动不清高亮，真正离开才清', async () => {
    const wrapper = mountTree()
    const wrap = wrapper.findAll('.tree-row-wrap')[1]
    await wrap.trigger('dragover')
    expect(wrap.classes()).toContain('is-drag-over')

    const inner = wrap.find('button.tree-row').element
    await wrap.trigger('dragleave', { relatedTarget: inner })
    expect(wrap.classes()).toContain('is-drag-over')

    await wrap.trigger('dragleave')
    expect(wrap.classes()).not.toContain('is-drag-over')
  })

  it('drop 带出落点的文件夹 key', async () => {
    const wrapper = mountTree()
    await wrapper.findAll('.tree-row-wrap')[1].trigger('drop')
    expect(wrapper.emitted('drop-items')?.[0]).toEqual(['chars'])
  })

  it('删除按钮带出文件夹 key', async () => {
    const wrapper = mountTree()
    await wrapper.findAll('.tree-actions button')[1].trigger('click')
    expect(wrapper.emitted('delete-folder')?.[0]).toEqual(['chars'])
  })
})
