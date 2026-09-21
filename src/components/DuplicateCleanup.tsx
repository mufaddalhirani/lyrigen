import { useEffect, useState } from 'react'
import { Icon } from './common/Icon'

/**
 * Review and clear duplicate files.
 *
 * Nothing is removed without showing which copy survives and why, because the
 * grouping rule — same title, identical file size — is a heuristic, and a
 * heuristic that deletes without asking is a bad trade. Files go to the
 * Recycle Bin, so a wrong call costs a restore rather than the file.
 */

function megabytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function fileName(fullPath: string) {
  return fullPath.split(/[\\/]/).pop() ?? fullPath
}

export function DuplicateCleanup({ onDone, flash }: { onDone: () => void; flash: (message: string) => void }) {
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null)
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const load = () => {
    setGroups(null)
    void window.electronAPI.planDuplicateCleanup().then(setGroups).catch(() => setGroups([]))
  }
  useEffect(load, [])

  const active = (groups ?? []).filter(group => !skipped.has(group.key))
  const files = active.flatMap(group => group.remove)
  const reclaimed = files.reduce((total, file) => total + file.size, 0)

  const cleanUp = async () => {
    if (!files.length) return
    if (!window.confirm(`Send ${files.length} duplicate file${files.length === 1 ? '' : 's'} to the Recycle Bin? One copy of each song is kept, and nothing is permanently deleted.`)) return
    setBusy(true)
    try {
      const result = await window.electronAPI.trashFiles(files.map(file => file.path))
      flash(`${result.trashed} file${result.trashed === 1 ? '' : 's'} moved to the Recycle Bin.${result.failed.length ? ` ${result.failed.length} could not be moved.` : ''}`)
      onDone()
      load()
    } finally {
      setBusy(false)
    }
  }

  if (!groups) return <div className="history-empty">Looking for duplicates…</div>
  if (!groups.length) return <div className="collection-empty"><strong>No duplicates</strong><p>No two files share a title and an exact size. Your library looks tidy.</p></div>

  return (
    <div className="dupe-cleanup">
      <div className="dupe-head">
        <div>
          <span className="kicker">DUPLICATE CLEANUP</span>
          <h4>{active.length} group{active.length === 1 ? '' : 's'} · {files.length} file{files.length === 1 ? '' : 's'} can go</h4>
          <p>Grouped by identical title and file size. One copy of each is kept — the one with lyrics beside it, or the shortest path. Files go to the Recycle Bin, never deleted outright. {reclaimed > 0 && <b>Frees about {megabytes(reclaimed)}.</b>}</p>
        </div>
        <button className="accent-button" disabled={busy || !files.length} onClick={() => void cleanUp()}>
          {busy ? 'Moving…' : `Move ${files.length} to Recycle Bin`}
        </button>
      </div>

      <div className="dupe-groups">
        {groups.map(group => {
          const off = skipped.has(group.key)
          return (
            <div className={`dupe-group ${off ? 'skipped' : ''}`} key={group.key}>
              <div className="dupe-group-head">
                <strong>{group.title}</strong>
                <button className="text-link" onClick={() => setSkipped(current => {
                  const next = new Set(current)
                  if (next.has(group.key)) next.delete(group.key); else next.add(group.key)
                  return next
                })}>{off ? 'Include' : 'Skip this one'}</button>
              </div>
              <div className="dupe-file keep" title={group.keep.path}>
                <Icon name="check" size={14} /><span>{fileName(group.keep.path)}</span><em>keeping · {group.keep.reason}</em>
              </div>
              {group.remove.map(file => (
                <div className="dupe-file remove" key={file.path} title={file.path}>
                  <Icon name="close" size={14} /><span>{fileName(file.path)}</span><em>{megabytes(file.size)}</em>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
