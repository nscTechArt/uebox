import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import zhCN from '@renderer/i18n/locales/zh-CN'
import enUS from '@renderer/i18n/locales/en-US'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/views/Notebook/components/NoteStudioPanel.vue'),
  'utf8'
)

describe('NoteStudioPanel output filters', () => {
  it('renders the compact filter controls directly in one row', () => {
    expect(source).toContain('<div id="output-filter-panel" class="output-filter-panel">')
    expect(source).not.toContain('filtersCollapsed')
    expect(source).not.toContain('output-toolbar-head')
    expect(source).not.toContain('filter-toggle-btn')
  })

  it('omits empty output types instead of rendering a wall of zero-count chips', () => {
    expect(source).toContain('const visibleOutputTypeFilters = computed')
    expect(source).toContain('Boolean(filter.count)')
    expect(source).not.toContain('class="filter-chip')
  })

  it('uses compact desktop controls with larger coarse-pointer targets', () => {
    expect(source).toContain('min-height: var(--space-8)')
    expect(source).toContain('appearance: none')
    expect(source).toContain('@media (pointer: coarse)')
    expect(source).toContain('min-height: calc(var(--space-10) - var(--space-1))')
  })

  it('separates sorting from the three filter controls', () => {
    expect(source).toContain('class="output-filter-field output-type-filter"')
    expect(source).toContain('class="output-filter-field output-status-filter"')
    expect(source).toContain('class="output-filter-field output-time-filter"')
    expect(source).toContain('class="output-filter-field output-sort-filter"')
    expect(source).toContain('margin-left: auto')
  })

  it('keeps the filter copy aligned in both locales', () => {
    const zhFilters = zhCN.notebook.studio.filters
    const enFilters = enUS.notebook.studio.filters

    expect(Object.keys(enFilters)).toEqual(Object.keys(zhFilters))
    expect(Object.keys(enFilters.type)).toEqual(Object.keys(zhFilters.type))
    expect(Object.keys(enFilters.status)).toEqual(Object.keys(zhFilters.status))
    expect(Object.keys(enFilters.time)).toEqual(Object.keys(zhFilters.time))
    expect(Object.keys(enFilters.sort)).toEqual(Object.keys(zhFilters.sort))
  })
})
