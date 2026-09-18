/** Real Electron + HyperFrames + FFmpeg acceptance, with no paid providers. */
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const out = path.resolve(process.argv[2] || 'tmp/task-video-art')
await mkdir(out, { recursive: true })
const entry = path.join(out, 'acceptance-entry.mjs')
await writeFile(
  entry,
  `
import { app } from 'electron';
import { writeFile, readFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { renderComposition } from ${JSON.stringify(path.resolve('src/main/services/taskVideo/composition.ts'))};
import { renderTaskVideo } from ${JSON.stringify(path.resolve('src/main/services/taskVideo/render.ts'))};
import { VideoStoryboard } from ${JSON.stringify(path.resolve('src/main/services/taskVideo/schema.ts'))};
(async () => {
app.getAppPath = () => ${JSON.stringify(process.cwd())};
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.on('window-all-closed',()=>{});
await app.whenReady();
try {
 const root = ${JSON.stringify(out)};
 const source = path.join(root,'index.html');
 const output = path.join(root,'video.mp4');
 const result = await renderComposition({source, output, ffmpeg:process.env.UNREAL_BOX_FFMPEG_PATH || 'ffmpeg', ratio:'16:9', duration:Number(process.env.ART_DURATION || 4), previewOnly:process.env.ART_PREVIEW === '1', sampleTimes: [2.8,5,7.3,9.5,11.4,13.4,15,17.5,19.2,21.5,22.5], report:console.log});
 assert.ok(result.length >= 4);
 const a = await readFile(result[0]), b = await readFile(result[2]);
 assert.notDeepEqual(a,b,'The composition must actually change over time');
 let delivered;
 if(process.env.ART_PIPELINE === '1') {
   const board = VideoStoryboard.parse({title:'虚幻盒子 · 让想法拥有形状',mode:'promo',voice:'off',musicPath:path.join(root,'score.wav'),musicVolume:0.8,scenes:[{id:'film',kind:'composition',source,sourceNote:'艺术方向样片，AI 概念画面，不是引擎实录',compositionAssets:[{name:'world.png',source:path.join(root,'assets','world.png')}],title:'',caption:'',duration:Number(process.env.ART_DURATION || 24)}]});
   delivered = await renderTaskVideo(root,board,undefined,console.log);
   await copyFile(delivered.videoPath,output);
 }
 await writeFile(path.join(root,'acceptance.json'),JSON.stringify({video:output,previews:result,delivered},null,2));
 console.log('ART_ACCEPTANCE_OK',output);
 app.exit(0);
} catch(e) {console.error(e);app.exit(1)}
})()
`
)
await build({
  entryPoints: [entry],
  outfile: path.join(out, 'acceptance.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  plugins: [
    {
      name: 'offline-provider-fixture',
      setup(b) {
        b.onResolve({ filter: /(?:ai\/store|ai\/speech)$/ }, (a) => ({
          path: a.path,
          namespace: 'offline'
        }))
        b.onLoad({ filter: /.*/, namespace: 'offline' }, (a) => ({
          contents: a.path.endsWith('store')
            ? 'export async function readSettings(){return {providers:[],roles:{}}}'
            : 'export async function requestSpeech(){throw Error("Unexpected paid speech")}'
        }))
        b.onResolve({ filter: /ffmpegPath$/ }, (a) => ({ path: a.path, namespace: 'ffmpeg' }))
        b.onLoad({ filter: /.*/, namespace: 'ffmpeg' }, () => ({
          contents:
            'export async function findFFmpeg(){return process.env.UNREAL_BOX_FFMPEG_PATH || "ffmpeg"}'
        }))
      }
    }
  ]
})
const electron = createRequire(import.meta.url)('electron')
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [path.join(out, 'acceptance.cjs')], {
  windowsHide: true,
  stdio: 'inherit',
  env: environment
})
child.on('error', (e) => {
  console.error(e)
  process.exitCode = 1
})
child.on('close', (code) => {
  process.exitCode = code ?? 1
})
