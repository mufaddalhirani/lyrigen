# Lyric Studio installer.
#
# 1. Finds Python 3.10 or newer.
# 2. Installs Lyric Studio and everything it needs with pip — plus NVIDIA's
#    CUDA 12 libraries when an NVIDIA GPU is present, so the GPU just works.
# 3. Adds "Lyric Studio" to the Start menu and the desktop.
#
# The AI models (Whisper, and the 1.2 GB syllable aligner) download on first
# use, not here, so installing stays quick.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host ''
Write-Host '  Lyric Studio installer' -ForegroundColor Magenta
Write-Host ''

function Find-Python {
  foreach ($candidate in @(@('py', '-3'), @('python'), @('python3'))) {
    $exe = $candidate[0]; $pre = @($candidate | Select-Object -Skip 1)
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
    try {
      $version = & $exe @pre -c "import sys; print('%d.%d' % sys.version_info[:2]); print(sys.executable)" 2>$null
      if ($LASTEXITCODE -eq 0 -and $version) {
        $lines = @($version)
        $parts = $lines[0].Split('.')
        if ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 10) { return @{ Exe = $exe; Pre = $pre; Path = $lines[1]; Version = $lines[0] } }
      }
    } catch { }
  }
  return $null
}

$python = Find-Python
if (-not $python) {
  Write-Host '  Python 3.10 or newer was not found.' -ForegroundColor Yellow
  Write-Host '  Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH"),'
  Write-Host '  or run:  winget install Python.Python.3.12'
  Write-Host '  then run this installer again.'
  exit 1
}
Write-Host "  Using Python $($python.Version) at $($python.Path)"

$target = $here
$hasNvidia = [bool](Get-Command nvidia-smi -ErrorAction SilentlyContinue)
if ($hasNvidia) {
  Write-Host '  NVIDIA GPU found: installing its CUDA 12 libraries too (about 1.2 GB, once).'
  $target = "$here[gpu]"
}

Write-Host '  Installing Lyric Studio and its packages (this can take a few minutes)...'
& $python.Exe @($python.Pre) -m pip install --disable-pip-version-check --upgrade "$target"
if ($LASTEXITCODE -ne 0) { Write-Host '  pip failed; see the messages above.' -ForegroundColor Red; exit 1 }

# The GUI launcher pip created, or pythonw -m lyricstudio as a fallback.
$scripts = & $python.Exe @($python.Pre) -c "import sysconfig; print(sysconfig.get_path('scripts'))"
$launcher = Join-Path $scripts 'lyric-studio.exe'
$shell = New-Object -ComObject WScript.Shell
$places = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))
foreach ($place in $places) {
  $link = $shell.CreateShortcut((Join-Path $place 'Lyric Studio.lnk'))
  if (Test-Path $launcher) {
    $link.TargetPath = $launcher
  } else {
    $link.TargetPath = ($python.Path -replace 'python\.exe$', 'pythonw.exe')
    $link.Arguments = '-m lyricstudio'
  }
  $link.Description = 'Word- and syllable-timed lyrics, made on your computer'
  $link.WorkingDirectory = [Environment]::GetFolderPath('MyMusic')
  $link.Save()
}

Write-Host ''
Write-Host '  Done. Open "Lyric Studio" from the Start menu or your desktop.' -ForegroundColor Green
Write-Host '  The first sync downloads the AI models once; after that it works offline.'
Write-Host ''
