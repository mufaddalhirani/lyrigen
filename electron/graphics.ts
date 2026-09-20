import { app } from 'electron'

/**
 * Graphics bootstrap.
 *
 * Profiling on a GTX 1650 machine found Lyrigen running entirely on
 * SwiftShader -- Chromium's software rasteriser -- while the same machine
 * drove a modern Chromium on the real GPU without complaint. With GPU
 * compositing off, every gradient, transform and album-art downscale is
 * painted by the CPU, which is what made the app feel heavy no matter how
 * carefully the CSS was written.
 *
 * These switches must be applied before the app 'ready' event, so this
 * module is imported for its side effect at the very top of main.ts.
 */
export function configureGraphics() {
  // Explicit recovery mode for genuinely broken drivers.
  if (process.argv.includes('--safe-graphics')) {
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('disable-gpu')
    return 'software (forced by --safe-graphics)'
  }

  // Chromium ships a conservative GPU blocklist. On Windows it will quietly
  // fall back to SwiftShader for driver/GPU combinations that are in practice
  // fine, and the fallback is silent -- nothing in the UI says the app is now
  // painting in software.
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch('enable-gpu-rasterization')
  app.commandLine.appendSwitch('enable-zero-copy')

  // D3D11 through ANGLE is the reliable path on Windows. Leave other
  // platforms on their default backend.
  if (process.platform === 'win32') {
    app.commandLine.appendSwitch('use-angle', 'd3d11')
  }

  return 'hardware (blocklist bypassed)'
}

/**
 * Reads back what Chromium actually decided, so a fallback to software is
 * visible in the log instead of silent. Call after 'ready'.
 */
export function reportGraphicsStatus() {
  try {
    const status = app.getGPUFeatureStatus() as unknown as Record<string, string>
    const compositing = status.gpu_compositing || 'unknown'
    const rasterization = status.rasterization || 'unknown'
    const software =
      compositing.includes('software') || rasterization.includes('software')

    if (software) {
      console.warn(
        '[graphics] Running WITHOUT GPU acceleration -- compositing:',
        compositing,
        'rasterization:',
        rasterization,
      )
      console.warn('[graphics] The UI will be painted by the CPU and will feel slower.')
    } else {
      console.log('[graphics] GPU acceleration active -- compositing:', compositing)
    }
    return { software, status }
  } catch (error) {
    console.warn('[graphics] Could not read GPU feature status', error)
    return { software: null, status: {} }
  }
}
