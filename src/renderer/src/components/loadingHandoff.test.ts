import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compileStyleAsync, parse } from '@vue/compiler-sfc'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

// These containers replace an already visible skeleton. A fresh entrance
// animation (especially one with backwards fill and a delay) blanks them again.
// Test the compiled page CSS; local spinners, hover and thumbnail effects are outside this guard.
const pages = [
  ['Home/Home.vue', ['tools-section', 'engine-section', 'project-section']],
  ['Notebook/NotebookList.vue', ['gallery-header', 'content-area']],
  [
    'AssetManagement/index.vue',
    ['tree-panel', 'navigation-section', 'command-bar', 'file-list-section']
  ],
  [
    'AIGCStudio/index.vue',
    ['input-panel-container', 'preview-container', 'history-panel-container']
  ],
  ['library-common/components/LibraryGrid.vue', ['library-grid']],
  ['library-common/components/LibraryListTable.vue', ['library-list']]
] as const

describe('skeleton to content handoff', () => {
  it.each(pages)('%s keeps page containers visible on their first frame', async (file, classes) => {
    const filename = resolve('src/renderer/src/views', file)
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
    const offending: string[] = []
    for (const style of descriptor.styles) {
      const result = await compileStyleAsync({
        filename,
        source: style.content,
        id: 'data-v-handoff',
        scoped: style.scoped,
        preprocessLang: style.lang === 'less' ? 'less' : undefined
      })
      expect(result.errors).toEqual([])
      postcss.parse(result.code).walkRules((rule) => {
        // Only the container itself, not descendant icons or controls.
        const target = classes.some((name) =>
          new RegExp(`\\.${name}(?:\\[data-v-handoff\\])?$`).test(rule.selector)
        )
        if (!target) return
        rule.walkDecls(/^animation(?:-name)?$/, (decl) => {
          if (decl.value !== 'none') offending.push(`${rule.selector}: ${decl.value}`)
        })
      })
    }
    expect(offending).toEqual([])
  })
})
