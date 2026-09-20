// Extracted from the former 45KB single-file App.tsx.

import { memo, useEffect, useState } from 'react'
import { Icon } from './Icon'

/**
 * Album art.
 *
 * Asks the main process for a cached thumbnail sized to how the image is
 * actually drawn, rather than the original file. Library views used to hold
 * ~82 megapixels of decoded bitmap to fill under 2 megapixels of screen.
 *
 * Memoised because a library list re-renders far more often than its covers
 * change, and every remount costs an IPC round trip.
 */
export const Artwork = memo(function Artwork({ track, large = false }: { track?: LibraryTrack | null; large?: boolean }) {
  const [source, setSource] = useState('')
  const coverPath = track?.coverPath
  // Rows draw at 42px, cards at ~180px; ask for the next tier up so the image
  // still looks right on a HiDPI display.
  const requestedSize = large ? 256 : 128

  useEffect(() => {
    let active = true
    setSource('')
    if (!coverPath) return
    window.electronAPI
      .getArtworkUrl(coverPath, requestedSize)
      .then(url => { if (active && url) setSource(url) })
      .catch(() => undefined)
    return () => { active = false }
  }, [coverPath, requestedSize])

  return <div className={`artwork ${large ? 'artwork-large' : ''}`}>
    {source
      ? <img src={source} alt="" loading="lazy" decoding="async" draggable={false} />
      : <span><Icon name="music" size={large ? 32 : 18} /></span>}
  </div>
})
