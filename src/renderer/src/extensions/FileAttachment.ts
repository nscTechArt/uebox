import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import FileAttachmentComponent from '../components/FileAttachment.vue'

export const FileAttachment = Node.create({
  name: 'fileAttachment',

  group: 'block',

  atom: true,

  draggable: true,

  addAttributes() {
    return {
      path: {
        default: null
      },
      name: {
        default: null
      },
      size: {
        default: 0
      },
      mtime: {
        default: null
      }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'file-attachment'
      }
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['file-attachment', mergeAttributes(HTMLAttributes)]
  },

  addNodeView() {
    return VueNodeViewRenderer(FileAttachmentComponent)
  }
})
