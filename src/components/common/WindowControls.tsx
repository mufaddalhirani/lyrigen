// Extracted from the former 45KB single-file App.tsx.

export function WindowControls() { return <div className="window-controls"><button aria-label="Toggle fullscreen" onClick={() => window.electronAPI.toggleFullscreen()}>◩</button><button aria-label="Minimize" onClick={() => window.electronAPI.minimizeWindow()}>—</button><button aria-label="Close" className="close" onClick={() => window.electronAPI.closeWindow()}>×</button></div> }
