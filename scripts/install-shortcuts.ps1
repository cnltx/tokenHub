param([string]$DesktopPath = [Environment]::GetFolderPath('Desktop'))
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$resolvedDesktop = [IO.Path]::GetFullPath($DesktopPath)
if (-not (Test-Path -LiteralPath $resolvedDesktop -PathType Container)) { throw 'Desktop directory does not exist.' }
$iconPath = Join-Path $projectRoot 'public\tokenhub.ico'
if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) { throw 'tokenHub icon file is missing.' }
$shortcutShell = New-Object -ComObject WScript.Shell
foreach ($entry in @(@{Name='tokenHub';Script='start.vbs'}, @{Name='tokenHub Docker';Script='start-docker.vbs'})) {
  $shortcutPath = Join-Path $resolvedDesktop ($entry.Name + '.lnk')
  $launcherPath = Join-Path $projectRoot $entry.Script
  if (Test-Path -LiteralPath $shortcutPath) {
    $previous = $shortcutShell.CreateShortcut($shortcutPath)
    if (-not $previous.Arguments.Contains($projectRoot)) { throw ('Existing unrelated shortcut: ' + $shortcutPath) }
  }
  $shortcut = $shortcutShell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $shortcut.Arguments = '"' + $launcherPath + '"'
  $shortcut.WorkingDirectory = $projectRoot
  $shortcut.IconLocation = $iconPath + ',0'
  $shortcut.WindowStyle = 7
  $shortcut.Description = 'tokenHub local model gateway'
  $shortcut.Save()
  Write-Output ('Created: ' + $shortcutPath)
}
