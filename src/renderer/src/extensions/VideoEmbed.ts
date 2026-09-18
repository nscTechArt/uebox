import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import VideoEmbedComponent from '../components/VideoEmbed.vue'

/**
 * 笔记里内嵌一段能播的视频。
 *
 * 和 FileAttachment 的区别：那个是「这儿挂了个文件」的卡片，点开用外部程序；
 * 这个是就地播放。资产说明书里演示操作步骤，要的是后者。
 *
 * src 存的是保管库里的绝对路径（note:saveVideo 给的），渲染时再转成本地资源
 * URL —— 和笔记里的图片一个规矩，跟着保管库走。
 */
export const VideoEmbed = Node.create({
  name: 'videoEmbed',

  group: 'block',

  atom: true,

  draggable: true,

  addAttributes() {
    return {
      src: {
        default: null
      },
      /** 原始文件名，只用于显示和无障碍标签 */
      name: {
        default: null
      }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'video-embed'
      }
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['video-embed', mergeAttributes(HTMLAttributes)]
  },

  addNodeView() {
    return VueNodeViewRenderer(VideoEmbedComponent)
  }
})
