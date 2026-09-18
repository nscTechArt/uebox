import {
  computed,
  inject,
  provide,
  reactive,
  type ComputedRef,
  type InjectionKey,
  type Ref
} from 'vue'
import type { FileChange } from '../../../../../shared/fileChange'

export type OpenFileReview = (changes: FileChange[], selectedPath: string) => void
export const fileReviewKey: InjectionKey<OpenFileReview> = Symbol('file-review')

export function useFileReview(): OpenFileReview | undefined {
  return inject(fileReviewKey, undefined)
}

interface FileReviewState {
  changes: FileChange[]
  selectedPath: string
  active: boolean
}

export function provideFileReview(sid: Ref<string>): {
  review: ComputedRef<FileReviewState | undefined>
  select: () => void
  selectBrowser: () => void
  close: () => void
} {
  const sessions = reactive(
    new Map<string, { changes: FileChange[]; selectedPath: string; active: boolean }>()
  )
  const review = computed(() => sessions.get(sid.value))
  const open: OpenFileReview = (changes, selectedPath) => {
    if (!changes.length) return
    sessions.set(sid.value, {
      changes: changes.map((change) => ({ ...change })),
      selectedPath,
      active: true
    })
  }
  provide(fileReviewKey, open)
  return {
    review,
    select: () => {
      if (review.value) review.value.active = true
    },
    selectBrowser: () => {
      if (review.value) review.value.active = false
    },
    close: () => sessions.delete(sid.value)
  }
}
