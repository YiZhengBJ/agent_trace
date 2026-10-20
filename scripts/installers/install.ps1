param([switch]$Headless)
$ErrorActionPreference = 'Stop'
$destination = if ($env:TRACE_INSTALL_DIR) { $env:TRACE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'TraceGatewayApp' }
if ((Test-Path $destination) -and (Get-ChildItem $destination -Force) -and -not (Test-Path (Join-Path $destination '.trace-managed'))) { throw 'Choose an empty TRACE_INSTALL_DIR; existing directory is unmanaged' }
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'cli/*') -Destination $destination -Recurse -Force
Set-Content -Path (Join-Path $destination '.trace-managed') -Value 'trace-gateway-v1'
Copy-Item (Join-Path $PSScriptRoot 'uninstall.ps1') $destination -Force
Set-Content -Path (Join-Path $destination 'trace-uninstall.cmd') -Value '@powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*' -Encoding Ascii
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $destination) {
    [Environment]::SetEnvironmentVariable('Path', "$destination;$userPath", 'User')
}
$env:Path = "$destination;$env:Path"
if (-not $Headless) {
    $installer = Get-ChildItem (Join-Path $PSScriptRoot 'desktop') -Filter '*-setup.exe' | Select-Object -First 1
    if (-not $installer) { throw 'Missing desktop installer' }
    $process = Start-Process -FilePath $installer.FullName -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Desktop installation failed: $($process.ExitCode)" }
    New-Item -ItemType File -Force (Join-Path $destination '.trace-desktop') | Out-Null
}
Write-Host "CLI installed: $destination\trace.exe. Open a new terminal to use trace."
Write-Host 'Node.js is bundled. Configure a provider with trace provider add; start with trace start.'

Write-Host "Uninstall: trace-uninstall (add -PurgeData to delete recordings)."
