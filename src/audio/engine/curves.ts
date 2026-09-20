/**
 * Waveshaper transfer curves.
 *
 * A WaveShaperNode maps input amplitude through a lookup table, so the shape of
 * the curve *is* the distortion character. These are hand-tuned rather than
 * generic tanh so each genre mode has its own grit.
 */

const SAMPLES = 4096

function buildCurve(shape: (x: number) => number) {
  const curve = new Float32Array(SAMPLES)
  for (let i = 0; i < SAMPLES; i += 1) {
    const x = (i * 2) / SAMPLES - 1
    curve[i] = Math.max(-1, Math.min(1, shape(x)))
  }
  return curve
}

/** Smooth symmetric saturation. Warmth without obvious breakup. */
export function softSaturation(amount: number) {
  const k = 1 + Math.max(0, amount) * 8
  const norm = Math.tanh(k)
  return buildCurve(x => Math.tanh(x * k) / norm)
}

/**
 * Asymmetric drive with odd-harmonic bias -- the hard, buzzy edge that defines
 * phonk's distorted 808s. The asymmetry is what separates it from clean
 * saturation; symmetric curves sound polite.
 */
export function grittyDrive(amount: number) {
  const k = 1 + Math.max(0, amount) * 24
  return buildCurve(x => {
    const driven = Math.tanh(x * k)
    const bias = 0.18 * Math.tanh(x * x * k * 0.5) * Math.sign(x)
    return (driven + bias) / 1.18
  })
}

/**
 * Bit-crush style quantisation. Steps the signal to a coarse grid, which is
 * the digital-tearing artefact glitchcore is built on.
 */
export function bitCrush(bits: number) {
  const levels = Math.pow(2, Math.max(1, bits))
  return buildCurve(x => Math.round(x * levels) / levels)
}

/**
 * Gentle analogue-style compression curve. Used to squash transients so beats
 * read as aggressive and forward rather than dynamic.
 */
export function transientSquash(amount: number) {
  const k = Math.max(0, Math.min(1, amount))
  return buildCurve(x => {
    const sign = Math.sign(x)
    const magnitude = Math.abs(x)
    // Blend linear with a square-root curve: the root lifts quiet detail and
    // flattens peaks, which is exactly what squashing transients sounds like.
    return sign * (magnitude * (1 - k) + Math.sqrt(magnitude) * k)
  })
}
