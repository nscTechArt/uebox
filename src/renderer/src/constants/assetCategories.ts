import {
  PhCode,
  PhFile,
  PhFileImage,
  PhHeadphones,
  PhSquaresFour,
  PhVideoCamera
} from '@phosphor-icons/vue'

/**
 * 资产的格式分类。
 *
 * **这里没有 label。** 原来每条都带一句 `'图片 (Image)'` 这样的中英混排标签，
 * 而两个消费者（`AssetFilterBar.vue`、`AssetManagement/index.vue`）都不用它 ——
 * 前者按 key 拼 `assetLib.filter.format*` 去查语言包并把 label 整个覆盖掉，
 * 后者只读 extensions。留着就是一份永远不会被显示、却会被下一个人当真的死文案。
 */
export const ASSET_CATEGORIES = [
  {
    key: 'image',
    icon: PhFileImage,
    extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tga', 'psd', 'svg', 'webp']
  },
  {
    key: 'video',
    icon: PhVideoCamera,
    extensions: ['mp4', 'avi', 'mov', 'mkv', 'wmv', 'webm']
  },
  {
    key: 'model',
    icon: PhSquaresFour,
    extensions: ['fbx', 'obj', 'gltf', 'glb', 'stl', 'blend']
  },
  {
    key: 'audio',
    icon: PhHeadphones,
    extensions: ['wav', 'mp3', 'ogg', 'flac']
  },
  {
    key: 'code',
    icon: PhCode,
    extensions: ['cpp', 'h', 'cs', 'py', 'js', 'ts', 'json', 'xml']
  },
  {
    key: 'uasset',
    icon: PhFile,
    extensions: ['uasset', 'umap']
  }
]
