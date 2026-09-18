import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/views/ScreenRecorder/ScreenRecorderLibrary.vue'),
  'utf8'
)

describe('ScreenRecorderLibrary progressive disclosure', () => {
  it('keeps secondary actions and the file path inside native details', () => {
    const detailsStart = source.indexOf('<details class="file-details">')
    const visibleSummary = source.slice(source.indexOf('<div class="info-section">'), detailsStart)
    const details = source.slice(detailsStart)

    expect(visibleSummary).toContain('screenRecorderLibrary.detail.openInPlayer')
    expect(visibleSummary).not.toContain('screenRecorderLibrary.detail.openLocation')
    expect(visibleSummary).not.toContain('screenRecorderLibrary.detail.delete')
    expect(visibleSummary).not.toContain('screenRecorderLibrary.detail.filePath')
    expect(details).toContain(
      "<summary>{{ $t('screenRecorderLibrary.detail.moreDetails') }}</summary>"
    )
    expect(details).toContain('screenRecorderLibrary.detail.openLocation')
    expect(details).toContain('screenRecorderLibrary.detail.delete')
    expect(details).toContain('screenRecorderLibrary.detail.filePath')
  })

  it('keeps video content behind an unloaded preview disclosure by default', () => {
    const infoStart = source.indexOf('<div class="info-section">')
    const previewStart = source.indexOf('<details class="preview-details">')
    const beforePreview = source.slice(infoStart, previewStart)
    const preview = source.slice(previewStart)

    expect(previewStart).toBeGreaterThan(infoStart)
    expect(beforePreview).not.toContain('<video')
    expect(preview).toContain('screenRecorderLibrary.detail.previewDisclosure')
    expect(preview).toContain('<video')
    expect(preview).toContain('preload="none"')
  })

  it('keeps the recording list keyboard operable and exposes control names', () => {
    expect(source).toMatch(/<button\s+v-for="item in filteredRecordings"/)
    expect(source).toContain(':aria-pressed="item.path === selectedPath"')
    expect(source).toContain(':aria-label="$t(\'screenRecorderLibrary.list.searchLabel\')"')
    expect(source).toContain(':aria-label="$t(\'screenRecorderLibrary.list.refreshTitle\')"')
  })

  it('uses the neutral selected-state tokens', () => {
    expect(source).toContain('background: var(--color-bg-selected);')
    expect(source).toContain('background: var(--color-bg-selected-hover);')
    expect(source).not.toContain('background: var(--color-accent-bg);')
  })
})
