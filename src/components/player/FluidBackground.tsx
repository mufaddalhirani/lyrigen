import { memo, useEffect, useRef, type RefObject } from 'react'
import { Kawarp } from '@kawarp/core'
import type { BeatClock } from '../../lib/beat/beatClock'

/**
 * Fluid artwork background: the cover blurred and slowly warped, like Apple
 * Music's — the effect Better Lyrics Shaders brings to YouTube Music, drawn
 * by the same MIT-licensed renderer (Kawarp).
 *
 * Kept light on purpose:
 *  - The canvas is drawn at a fraction of the window's size. The picture is a
 *    blur, so nobody can tell, and the GPU fills a tenth of the pixels.
 *  - It draws 30 frames a second while music plays, 12 while paused, and none
 *    at all when the window is hidden or minimised.
 *  - Blurring happens once per cover inside Kawarp, not per frame.
 *
 * Audio reactive: a beat (bass well above its recent average) briefly speeds
 * the flow up and swells the picture, then both ease back.
 */

export interface FluidSettings {
  enabled: boolean
  opacity: number
  warp: number
  speed: number
  saturation: number
  reactive: boolean
}

export const DEFAULT_FLUID: FluidSettings = { enabled: true, opacity: 0.8, warp: 1, speed: 1, saturation: 1.5, reactive: true }

const STORAGE_KEY = 'lyrigen-fluid-v1'

export function loadFluidSettings(): FluidSettings {
  try { return { ...DEFAULT_FLUID, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<FluidSettings> } } catch { return DEFAULT_FLUID }
}

export function saveFluidSettings(settings: FluidSettings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)) } catch { /* the defaults are fine */ }
}

/** Share of the window's size the canvas is drawn at. */
const RESOLUTION = 0.3

type Props = {
  coverUrl: string
  settings: FluidSettings
  playing: boolean
  reducedMotion: boolean
  analyser: RefObject<AnalyserNode | null>
  /** When given, beats come from the song's beat grid instead of a loudness guess. */
  beats?: BeatClock
}

export const FluidBackground = memo(function FluidBackground({ coverUrl, settings, playing, reducedMotion, analyser, beats }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const kawarpRef = useRef<Kawarp | null>(null)
  const live = useRef({ playing, settings, reducedMotion, beats })
  live.current = { playing, settings, reducedMotion, beats }

  // One renderer for the life of the player; covers crossfade inside it.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let kawarp: Kawarp
    try {
      kawarp = new Kawarp(canvas, { transitionDuration: 1200, blurPasses: 8, dithering: 0.008 })
    } catch (error) {
      console.warn('Fluid background unavailable (no WebGL)', error)
      return
    }
    kawarpRef.current = kawarp

    const fit = () => {
      canvas.width = Math.max(64, Math.round(canvas.clientWidth * RESOLUTION))
      canvas.height = Math.max(64, Math.round(canvas.clientHeight * RESOLUTION))
      kawarp.resize()
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(canvas)

    let frame = 0
    let last = 0
    let pulse = 0
    let average = 0
    let lastBeat = 0
    const bins = new Uint8Array(128)
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop)
      if (document.hidden) return
      const { playing: isPlaying, settings: current, reducedMotion: still } = live.current
      const interval = isPlaying && !still ? 1000 / 30 : 1000 / 12
      if (now - last < interval) return
      last = now

      const clock = live.current.beats
      const node = analyser.current
      if (current.reactive && isPlaying && clock?.grid && !still) {
        pulse = Math.max(pulse * 0.86, clock.sample().pulse)
      } else if (current.reactive && isPlaying && node && !still) {
        node.getByteFrequencyData(bins)
        const bass = (bins[0] + bins[1] + bins[2] + bins[3]) / (4 * 255)
        average = average ? average * 0.94 + bass * 0.06 : bass
        if (bass > 0.3 && bass > average * 1.18 && now - lastBeat > 280) { pulse = 1; lastBeat = now }
      }
      pulse *= 0.86
      const base = still ? 0.15 : current.speed * (isPlaying ? 1 : 0.35)
      kawarp.animationSpeed = base * (1 + pulse * 3)
      kawarp.scale = 1 + pulse * 0.03
      kawarp.renderFrame()
    }
    frame = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      kawarp.dispose()
      kawarpRef.current = null
    }
  }, [analyser])

  useEffect(() => {
    kawarpRef.current?.setOptions({ warpIntensity: settings.warp, saturation: settings.saturation })
  }, [settings.warp, settings.saturation])

  // A file:// cover would taint the WebGL texture, so the main process hands
  // over a small copy as a data URL.
  useEffect(() => {
    let active = true
    const kawarp = kawarpRef.current
    if (!kawarp || !coverUrl) return
    const load = coverUrl.startsWith('data:') ? Promise.resolve(coverUrl) : window.electronAPI.getArtworkData(coverUrl, 256)
    void load.then(data => {
      if (active && data) return kawarpRef.current?.loadImage(data)
    }).catch(error => console.warn('Fluid background could not load the cover', error))
    return () => { active = false }
  }, [coverUrl])

  return <canvas ref={canvasRef} className="fluid-background" style={{ opacity: settings.opacity }} aria-hidden="true" />
})
