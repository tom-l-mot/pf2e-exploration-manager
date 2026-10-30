$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskStage = Join-Path $taskRoot 'build/pf2e-exploration-manager'
New-Item -ItemType Directory -Force -Path $taskStage | Out-Null
Copy-Item -LiteralPath (Join-Path $taskRoot 'module.json'), (Join-Path $taskRoot 'README.md') -Destination $taskStage -Force
New-Item -ItemType Directory -Force -Path (Join-Path $taskStage 'scripts') | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'main.js'), (Join-Path $PSScriptRoot 'handoff.js') -Destination (Join-Path $taskStage 'scripts') -Force
$taskZip = Join-Path $taskRoot 'build/pf2e-exploration-manager-0.1.0.zip'
Compress-Archive -LiteralPath $taskStage -DestinationPath $taskZip -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskArchive = [System.IO.Compression.ZipFile]::OpenRead($taskZip)
try {
    $taskActual = @($taskArchive.Entries.FullName | ForEach-Object { $_.Replace('\', '/') } | Sort-Object)
    $taskExpected = @('pf2e-exploration-manager/README.md', 'pf2e-exploration-manager/module.json', 'pf2e-exploration-manager/scripts/handoff.js', 'pf2e-exploration-manager/scripts/main.js' | Sort-Object)
    if (Compare-Object $taskActual $taskExpected) { throw 'Unexpected ZIP contents.' }
    $taskActual
} finally { $taskArchive.Dispose() }
