import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import ModelViewerComponent from '../components/NoteModelViewer.vue'

export const NoteModelViewer = Node.create({
  name: 'noteModelViewer',

  group: 'block',

  atom: true,

  draggable: true,

  addAttributes() {
    return {
      src: {
        default: null
      }
    }
  },

  parseHTML() {
    return [
      {
        tag: 'model-viewer'
      }
    ]
  },

  renderHTML({ HTMLAttributes }) {
    return ['model-viewer', mergeAttributes(HTMLAttributes)]
  },

  addNodeView() {
    return VueNodeViewRenderer(ModelViewerComponent)
  }
})
