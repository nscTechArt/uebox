import { readFileSync } from 'fs'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { computed, effectScope, nextTick, reactive, ref, watch, type Ref } from 'vue'
import { expect, it, vi } from 'vitest'
import { resolveAssetUrl } from '@renderer/utils/assetAccess'
import { listThumbnailUrl } from '@renderer/utils/listThumbnail'
import { toLocalResourceUrl } from '@renderer/utils/localResource'
import * as thumbnails from '@renderer/utils/thumbnails'

// Execute the real handlers without mounting the entire asset library and its IPC services.
function loadHandlers<T>(file: string, names: string[], scope: Record<string, unknown>): T {
  const source = parse(
    readFileSync(`src/renderer/src/views/AssetManagement/components/${file}`, 'utf8')
  ).descriptor.scriptSetup!.content
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const statements = ast.statements.filter((statement) =>
    ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.some((item) =>
          names.includes(item.name.getText(ast))
        )
      : names.includes('failedListThumbnails') &&
        ts.isExpressionStatement(statement) &&
        statement.getText(ast).includes('failedListThumbnails.value = new Set()')
  )
  const code = ts.transpileModule(statements.map((item) => item.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  return new Function(...Object.keys(scope), `${code}\nreturn {${names.join(',')}}`)(
    ...Object.values(scope)
  )
}

it('opens the original from the details panel, including backup paths', () => {
  const openImageViewer = vi.fn()
  const props = {
    asset: { assetName: 'photo', originPath: 'C:/old/photo.png', filePath: 'assetData/photo.png' }
  }
  const { handlePreviewImage } = loadHandlers<{ handlePreviewImage: () => void }>(
    'AssetDetailsPanel.vue',
    ['handlePreviewImage'],
    {
      props,
      isPreviewVideo: ref(false),
      isImageAsset: ref(true),
      currentVault: ref({ vaultType: 'backup', path: 'C:/vault' }),
      previewUrl: ref('local-resource://C:/vault/thumbnails/photo.webp'),
      folderPreviewUrl: ref(undefined),
      resolveAssetUrl,
      openImageViewer
    }
  )
  handlePreviewImage()
  expect(openImageViewer).toHaveBeenCalledWith({
    items: [{ src: 'local-resource://C:/vault/assetData/photo.png', alt: 'photo' }],
    index: 0
  })
})

it('keys reference thumbnails to the original and retries failures after reloading the folder', async () => {
  const file = {
    assetName: 'photo.png',
    originPath: 'C:/source/photo.png',
    imgLocalPath: 'old.webp'
  }
  const props = reactive({ files: [file], selectedFolderKey: 'one' })
  const effects = effectScope()
  try {
    const handlers = effects.run(() =>
      loadHandlers<{
        getThumbnailUrl: (item: typeof file) => string | undefined
        getThumbnailSourceUrl: (item: typeof file) => string | undefined
        failedListThumbnails: Ref<Set<string | undefined>>
      }>(
        'AssetFileList.vue',
        [
          'failedListThumbnails',
          'thumbnailRevision',
          'getThumbnailUrl',
          'getThumbnailSourceUrl',
          'isImageFile'
        ],
        {
          props,
          ref,
          watch,
          currentVault: ref({ id: 'vault', vaultType: 'reference', path: 'C:/vault' }),
          selectedAsset: ref(null),
          VaultType: { REFERENCE: 'reference', NETWORK: 'network' },
          resolveAssetUrl,
          listThumbnailUrl,
          toLocalResourceUrl,
          ...thumbnails
        }
      )
    )!
    const source = handlers.getThumbnailSourceUrl(file)
    expect(source).toBe('local-resource://C:/source/photo.png')
    const before = handlers.getThumbnailUrl(file)
    handlers.failedListThumbnails.value.add(source)
    expect(handlers.getThumbnailUrl(file)).toBeUndefined()
    props.files = [{ ...file }]
    await nextTick()
    expect(handlers.getThumbnailUrl(file)).toContain('listThumbnail=400')
    expect(handlers.getThumbnailUrl(file)).not.toBe(before)
    handlers.failedListThumbnails.value.add(source)
    props.selectedFolderKey = 'two'
    await nextTick()
    expect(handlers.getThumbnailUrl(file)).toContain('listThumbnail=400')
  } finally {
    effects.stop()
  }
})

it.each([
  [
    'file:///C:/vault/assetData/640_1788314480717.webp',
    'local-resource://C:/vault/assetData/640_1788314480717.webp'
  ],
  ['https://example.com/cover.webp', 'https://example.com/cover.webp']
])('loads saved cover URLs across list, details and original previews: %s', (url, expected) => {
  const selectedAsset = ref({ assetKey: 'photo', customPoster: url })
  const scope = {
    computed,
    selectedAsset,
    currentVault: ref({ vaultType: 'backup', path: 'C:/vault' }),
    VaultType: { REFERENCE: 'reference', NETWORK: 'network' },
    toLocalResourceUrl,
    ...thumbnails
  }
  type Cover = { assetKey: string; assetName: string; customPoster?: string; img?: string }
  const names = [
    'getThumbnailSourceUrl',
    'getOriginalThumbnailUrl',
    'getFolderCoverUrl',
    'getOriginalFolderCoverUrl'
  ]
  const handlers = loadHandlers<Record<string, (file: Cover) => string | undefined>>(
    'AssetFileList.vue',
    names,
    scope
  )
  const file = { assetKey: 'photo', assetName: 'photo.webp', customPoster: url, img: url }
  for (const name of names) expect(handlers[name](file)).toBe(expected)
  // The selected asset can hold a newer poster than the list record.
  expect(handlers.getThumbnailSourceUrl({ ...file, customPoster: undefined })).toBe(expected)
  expect(handlers.getOriginalThumbnailUrl({ ...file, customPoster: undefined })).toBe(expected)

  const props = reactive<{ asset: { customPoster?: string; thumbnail?: string } }>({
    asset: { customPoster: url }
  })
  const { previewUrl, folderPreviewUrl } = loadHandlers<{
    previewUrl: Ref<string | undefined>
    folderPreviewUrl: Ref<string | undefined>
  }>('AssetDetailsPanel.vue', ['previewUrl', 'folderPreviewUrl'], {
    ...scope,
    props: Object.assign(props, { folder: { img: url } }),
    isImageAsset: ref(false)
  })
  expect(folderPreviewUrl.value).toBe(expected)
  expect(previewUrl.value).toBe(expected)
  props.asset = { thumbnail: url }
  expect(previewUrl.value).toBe(expected)
  props.asset = {}
  expect(previewUrl.value).toBeUndefined()
})
