import { useEffect, useState } from 'react'

/**
 * Album art that changes with a little ceremony: the old cover sinks back
 * and fades while the new one settles in from slightly larger. The same image
 * again (the next song from the same album) stays still. The parent must be
 * positioned; the outgoing cover is laid over the incoming one while it fades.
 */
export function CoverSwap({ src, alt, className = '' }: { src: string; alt: string; className?: string }) {
  const [layers, setLayers] = useState({ current: src, previous: '', turn: 0 })

  useEffect(() => {
    setLayers(state => state.current === src ? state : { current: src, previous: state.current, turn: state.turn + 1 })
  }, [src])

  // Drop the outgoing cover once its fade is over.
  useEffect(() => {
    if (!layers.previous) return
    const timer = window.setTimeout(() => setLayers(state => ({ ...state, previous: '' })), 260)
    return () => window.clearTimeout(timer)
  }, [layers.turn, layers.previous])

  return <>
    <img key={`in-${layers.turn}`} src={layers.current} className={`${className} ${layers.turn ? 'cover-in' : ''}`} alt={alt} />
    {layers.previous && <img key={`out-${layers.turn}`} src={layers.previous} className={`${className} cover-out`} alt="" aria-hidden="true" />}
  </>
}
