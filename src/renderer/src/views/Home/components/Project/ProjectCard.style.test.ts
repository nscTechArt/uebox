import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectCardSources = ['ProjectSection.vue'].map((file) =>
  readFileSync(
    resolve(process.cwd(), 'src/renderer/src/views/Home/components/Project', file),
    'utf8'
  )
)

describe('project card corner clipping', () => {
  it.each(projectCardSources)('lets the outer card own the rounded clip', (source) => {
    expect(source).toMatch(
      /\.project-card\s*\{[^}]*border-radius:\s*var\(--radius-xl\);[^}]*overflow:\s*hidden;/s
    )
    expect(source).toMatch(
      /\.project-thumb\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s*auto;[^}]*aspect-ratio:\s*1;/s
    )
    expect(source).toMatch(/\.project-meta\s*\{[^}]*position:\s*static;/s)
  })
})

describe('project card long titles', () => {
  it.each(projectCardSources)('keeps unbroken names inside the card', (source) => {
    expect(source).toMatch(/\.project-thumb\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s)
    expect(source).toMatch(/\.project-meta\s*\{[^}]*min-width:\s*0;/s)
    expect(source).toMatch(
      /\.project-title\s*\{[^}]*white-space:\s*nowrap;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s
    )
  })
})

describe('project opening overlay', () => {
  it.each(projectCardSources)('keeps its content opaque over an 80% background', (source) => {
    expect(source).toMatch(
      /\.project-opening-overlay\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\(--color-accent-bg\) 80%,\s*transparent\);/s
    )
  })
})
