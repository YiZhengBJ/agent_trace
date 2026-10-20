param([switch]$Headless)
$ErrorActionPreference = 'Stop'
$destination = if ($env:TRACE_INSTALL_DIR) { $env:TRACE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'TraceGatewayApp' }
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'cli/*') -Destination $destination -Recurse -Force
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
}
Write-Host "CLI installed: $destination\trace.exe. Open a new terminal to use trace."
Write-Host 'Node.js is bundled. Configure a provider with trace provider add; start with trace start.'
