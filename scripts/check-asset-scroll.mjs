// Browser regression: run with `pnpm exec node scripts/check-asset-scroll.mjs`.
// Uses the production layout code, virtual scroller and styles with synthetic files.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { parse, compileStyleAsync } from '@vue/compiler-sfc'
import { chromium } from 'playwright-core'

const file = 'src/renderer/src/views/AssetManagement/components/AssetFileList.vue'
const source = process.argv.includes('--before')
  ? execFileSync('git', ['show', `HEAD:${file}`], { encoding: 'utf8' })
  : readFileSync(file, 'utf8')
const { descriptor } = parse(source.replace(/\r\n/g, '\n'))
const checkSelection = !process.argv.includes('--before')
const reveal = checkSelection
  ? 'async function trySelectAsset(' +
    descriptor.scriptSetup.content
      .split('async function trySelectAsset(')[1]
      .split('\nonUnmounted(')[0]
  : ''
const layout = descriptor.scriptSetup.content
  .split('// ========== 虚拟滚动配置 ==========')[1]
  .split('/**\n * 当选中文件夹变化时')[0]
const spacers = [...source.matchAll(/:style="\{ height: (.*?) \}"/g)]
  .map((match) => match[1])
  .filter((expression) => expression.includes('assetPadding'))
assert.equal(spacers.length, 2)
const browser = await chromium.launch({ channel: process.env.SCROLL_TEST_BROWSER || 'msedge' })
try {
  for (const size of [80, 120, 200]) {
    const css = await compileStyleAsync({
      source: descriptor.styles[0].content.replace(/v-bind\('([^']*)'\)/g, (_, expression) =>
        Function('gridItemSize', `return ${expression}`)(size)
      ),
      filename: file,
      id: 'scroll-test',
      preprocessLang: descriptor.styles[0].lang
    })
    assert.deepEqual(css.errors, [])
    const template = `<div class="asset-file-list"><div ref="containerRef" class="file-content">
      <div style="height:1000px">Folders</div><div ref="assetGridRef" class="file-grid"
      :style="{gridTemplateColumns: 'repeat(auto-fill,minmax(${size}px,1fr))'}">
      <div v-if="assetPaddingTop > 0" class="virtual-scroll-padding" :style="{height:${spacers[0]}}"></div>
      <div v-for="file in visibleAssetFiles" :key="file" class="file-item asset-item" :data-file-id="String(file)">
        <div class="file-icon"><div class="thumbnail-container"></div></div>
        <div class="file-info"><div class="file-name">Asset {{file}}</div></div>
      </div><div v-if="assetPaddingBottom > 0" class="virtual-scroll-padding" :style="{height:${spacers[1]}}"></div>
      </div></div></div>`
    const bundle = await build({
      stdin: {
        loader: 'ts',
        contents: `import {createApp,ref,computed,watch,onMounted,onUnmounted,nextTick} from 'vue/dist/vue.esm-bundler.js';
        import {useVirtualScroll} from './src/renderer/src/views/AssetManagement/composables/useVirtualScroll.ts';
        import {useFileSelection} from './src/renderer/src/views/AssetManagement/composables/useFileSelection.ts';
        createApp({setup(){const gridItemSize=ref(${size});
        const selection=useFileSelection({getItems:()=>assetFiles.value.map(i=>({id:String(i),type:'file'}))});
        const {containerRef,clearSelection,setSelected}=selection;
        const assetFiles=ref(Array.from({length:2000},(_,i)=>i));${layout}
        const props={selectionScope:'test',ensureFilesLoaded:async()=>true};
        const message={loading:()=>()=>{},warning:()=>{},error:console.error};const t=k=>k;const resolveErrorText=String;
        const getItemId=String;const isFileSectionExpanded=ref(true);let locateRequest=0;
        ${reveal}
        onMounted(()=>selection.initDragSelect(containerRef.value));
        watch(visibleAssetFiles,()=>selection.updateSelectables(),{flush:'post'});
        window.assetTest={selection,${checkSelection ? 'trySelectAsset' : ''}};
        return {containerRef,assetGridRef,assetPaddingTop,assetPaddingBottom,gridGapSize,visibleAssetFiles};
        },template:${JSON.stringify(template)}}).mount('#app');`,
        resolveDir: process.cwd()
      },
      bundle: true,
      alias: { '@renderer': process.cwd() + '/src/renderer/src' },
      write: false,
      format: 'iife',
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.setContent(`<style>:root{--space-2:8px;--space-3:12px;--space-4:16px}*{box-sizing:border-box}
      ${css.code}.asset-file-list{height:650px}</style><div id="app"></div>`)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const result = await page.evaluate(async () => {
      const frames = async (count) => {
        for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame)
      }
      await frames(10)
      const container = document.querySelector('.file-content')
      const initialHeight = container.scrollHeight
      let maxDrift = 0
      let maxHeightChange = 0
      for (const position of [500, 1100, 2000, 4000, initialHeight - 700, 2500, 1000]) {
        container.scrollTop = position
        const requested = container.scrollTop
        await frames(25)
        maxDrift = Math.max(maxDrift, Math.abs(container.scrollTop - requested))
        maxHeightChange = Math.max(
          maxHeightChange,
          Math.abs(container.scrollHeight - initialHeight)
        )
        if (!document.querySelector('.asset-item')) throw new Error('Empty file grid')
      }
      return { maxDrift, maxHeightChange }
    })
    assert.deepEqual(errors, [])
    console.log({ size, ...result })
    assert.ok(result.maxDrift <= 1, 'Scroll position moved without user input')
    assert.ok(result.maxHeightChange <= 1, 'Virtualization changed total content height')
    if (checkSelection) {
      const interaction = await page.evaluate(async () => {
        const { selection, trySelectAsset } = window.assetTest
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))
        const all = selection.getSelectedIds().length
        selection.handleItemClick('0', new MouseEvent('click'))
        selection.handleItemClick('120', new MouseEvent('click', { shiftKey: true }))
        const range = selection.getSelectedIds().length
        const found = await trySelectAsset('1000')
        const rect = document.querySelector('[data-file-id="1000"]')?.getBoundingClientRect()
        const area = document.querySelector('.file-content')
        const container = area.getBoundingClientRect()
        selection.clearSelection()
        const x = container.left + 1
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: 100 }))
        area.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: 100, bubbles: true }))
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: x + 500, clientY: 500 }))
        document.dispatchEvent(new MouseEvent('mouseup', { clientX: x + 500, clientY: 500 }))
        return {
          all,
          range,
          found,
          boxWorks: selection.getSelectedIds().length > 0,
          inView: !!rect && rect.top >= container.top && rect.bottom <= container.bottom
        }
      })
      console.log({ size, ...interaction })
      assert.deepEqual(interaction, {
        all: 2000,
        range: 121,
        found: true,
        boxWorks: true,
        inView: true
      })
    }
    await page.close()
  }
} finally {
  await browser.close()
}
