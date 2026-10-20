param([switch]$PurgeData)
$ErrorActionPreference = 'Stop'
$destination = $PSScriptRoot
$marker = Join-Path $destination '.trace-managed'
if (-not (Test-Path $marker) -or (Get-Content $marker -Raw).Trim() -ne 'trace-gateway-v1') { throw 'Missing installation ownership marker' }
$data = if ($env:TRACE_HOME) { $env:TRACE_HOME } else { Join-Path $env:LOCALAPPDATA 'trace-gateway' }
if ($PurgeData) {
    $data = [IO.Path]::GetFullPath($data)
    if ((Test-Path $data) -and ((Get-Item -LiteralPath $data).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Refusing to purge a linked data directory' }
    if ($data.TrimEnd('\') -in @($env:USERPROFILE.TrimEnd('\'), $destination.TrimEnd('\'), [IO.Path]::GetPathRoot($data).TrimEnd('\'))) { throw 'Unsafe data directory' }
    if ((Test-Path $data) -and -not ((Test-Path (Join-Path $data 'config.json')) -or (Test-Path (Join-Path $data 'control.token')))) { throw 'Directory has no Trace Gateway state' }
}
$task = Get-ScheduledTask -TaskName TraceGateway -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -InputObject $task
    Unregister-ScheduledTask -InputObject $task -Confirm:$false
}
& (Join-Path $destination 'trace.exe') --home $data stop
if ($LASTEXITCODE -ne 0) { throw 'Gateway stop failed; files were retained' }
if (Get-Process -Name trace-desktop -ErrorAction SilentlyContinue) { throw 'Quit Trace Gateway from the tray, then run trace-uninstall again' }
if (Test-Path (Join-Path $destination '.trace-desktop')) {
    $entries = Get-ItemProperty @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*') -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -eq 'Trace Gateway' }
    foreach ($entry in $entries) {
        $command = $entry.UninstallString
        if ($command -match '^"([^"\r\n]+\.exe)"\s*$') { $uninstaller = $Matches[1] }
        elseif ($command -match '^[^"\r\n]+\.exe$') { $uninstaller = $command }
        else { throw 'Unrecognized native uninstall command; uninstall Trace Gateway through Windows Settings and retry' }
        $process = Start-Process -FilePath $uninstaller -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "Desktop uninstall failed: $($process.ExitCode)" }
    }
    if (-not $entries) { Write-Host 'Desktop uninstall entry absent. If installed for all users, uninstall it in Windows Settings.' }
}
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
[Environment]::SetEnvironmentVariable('Path', (($userPath -split ';' | Where-Object { $_.TrimEnd('\') -ine $destination.TrimEnd('\') }) -join ';'), 'User')
if ($PurgeData -and (Test-Path $data)) { Remove-Item -LiteralPath $data -Recurse -Force }
Remove-Item -LiteralPath (Join-Path $destination 'runtime') -Recurse -Force
foreach ($name in @('trace.exe', 'trace-background.exe', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.trace-managed', '.trace-desktop', 'trace-uninstall.cmd', 'uninstall.ps1')) {
    $file = Join-Path $destination $name
    if (Test-Path $file) { Remove-Item -LiteralPath $file -Force }
}
if (-not (Get-ChildItem -LiteralPath $destination -Force)) { Remove-Item -LiteralPath $destination }
if ($PurgeData) { Write-Host 'Uninstalled; selected gateway data deleted.' } else { Write-Host "Uninstalled. Configuration and recordings retained: $data" }
