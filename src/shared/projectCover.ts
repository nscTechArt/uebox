export type ProjectCoverMode = 'auto' | 'custom'

/** Legacy imports have a generated thumbnail name; unknown user data stays protected. */
export function projectCoverMode(project: {
  coverMode?: ProjectCoverMode | null
  image?: string | null
}): ProjectCoverMode {
  if (project.coverMode) return project.coverMode
  if (!project.image) return 'auto'
  const filename = project.image.split(/[/\\]/).pop() || ''
  return /^thumbnail-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.png$/i.test(filename)
    ? 'auto'
    : 'custom'
}
