#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")]
    [string] $HostId,

    [string] $Alias = "",

    [Parameter(Mandatory = $true)]
    [string] $ServiceToken,

    [Parameter(Mandatory = $true)]
    [string] $PrimaryProjectPath,

    [Parameter(Mandatory = $true)]
    [string] $ControlBaseUrl,
    [string] $RepoPath = "",
    [string] $PrimaryProjectKey = "project",
    [string] $PrimaryProjectAlias = "",
    [string] $ListenerBaseUrl = "",
    [string] $LocalMonitorUrl = "",
    [string] $Capabilities = "intake,dispatch,verify,fix",
    [string] $RequestedCapabilities = "",
    [string] $CapabilityReportPath = "",
    [int] $MonitorPort = 3337,
    [int] $MaxConcurrentJobs = 1,
    [int] $WorkerPollMs = 15000,
    [ValidateSet("Auto", "RunKey", "ScheduledTaskLogon", "ScheduledTaskStartup")]
    [string] $Persistence = "Auto",
    [switch] $SkipMonitorInstall,
    [switch] $NoStart
)

$ErrorActionPreference = "Stop"

function Resolve-RepoPath {
    param([string] $Value)

    if ($Value) {
        return (Resolve-Path -LiteralPath $Value).Path
    }

    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
}

function Resolve-TailscaleUrl {
    param(
        [string] $Existing,
        [int] $Port
    )

    if ($Existing) {
        return $Existing
    }

    try {
        $tailnetIp = (& tailscale ip -4 2>$null | Select-Object -First 1).Trim()
        if ($tailnetIp) {
            return "http://$tailnetIp`:$Port"
        }
    } catch {
    }

    throw "Could not detect a Tailscale IPv4 address automatically. Pass -ListenerBaseUrl explicitly."
}

function Resolve-LocalRuntimeUrl {
    param(
        [string] $Existing,
        [int] $Port
    )

    if ($Existing) {
        return $Existing
    }

    return "http://localhost:$Port"
}

function Get-FirstExistingPath {
    param([string[]] $Candidates)

    foreach ($candidate in $Candidates) {
        if (-not $candidate) { continue }
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        return (Resolve-Path -LiteralPath $candidate).Path
    }

    return $null
}

function Resolve-WindowsPosixToolchain {
    $programFiles = $env:ProgramFiles
    $programFilesX86 = ${env:ProgramFiles(x86)}

    $dirCandidates = @(
        (Join-Path $programFiles "Git\usr\bin"),
        (Join-Path $programFiles "Git\bin"),
        (Join-Path $programFilesX86 "Git\usr\bin"),
        (Join-Path $programFilesX86 "Git\bin"),
        "C:\msys64\usr\bin"
    )

    $dirs = @()
    foreach ($candidate in $dirCandidates) {
        if (-not $candidate) { continue }
        if (-not (Test-Path -LiteralPath $candidate)) { continue }

        $hasUsefulTool =
            (Test-Path -LiteralPath (Join-Path $candidate "bash.exe")) -or
            (Test-Path -LiteralPath (Join-Path $candidate "sh.exe")) -or
            (Test-Path -LiteralPath (Join-Path $candidate "grep.exe"))

        if (-not $hasUsefulTool) { continue }

        $resolved = (Resolve-Path -LiteralPath $candidate).Path
        if ($dirs -notcontains $resolved) {
            $dirs += $resolved
        }
    }

    $bashPath = Get-FirstExistingPath @(
        (Join-Path $programFiles "Git\bin\bash.exe"),
        (Join-Path $programFiles "Git\usr\bin\bash.exe"),
        (Join-Path $programFilesX86 "Git\bin\bash.exe"),
        (Join-Path $programFilesX86 "Git\usr\bin\bash.exe"),
        "C:\msys64\usr\bin\bash.exe"
    )

    return [pscustomobject]@{
        BashPath = $bashPath
        PosixBinDirs = $dirs
    }
}

function Ensure-Directory {
    param([string] $Path)
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
}

function Import-EnvFile {
    param([string] $Path)

    foreach ($line in Get-Content -Path $Path -Encoding utf8 -ErrorAction Stop) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line.TrimStart().StartsWith("#")) { continue }

        $idx = $line.IndexOf("=")
        if ($idx -lt 1) { continue }

        $name = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1)
        Set-Item -Path ("Env:" + $name) -Value $value
    }
}

function Assert-WorkerStopped {
    param(
        [string] $RuntimeCmdPath,
        [string] $RuntimePsPath,
        [string] $ListenerPsPath,
        [string] $ListenerScriptPath,
        [string] $WorkerHostId,
        [int] $Port
    )

    $wrapperPaths = @($RuntimeCmdPath, $RuntimePsPath, $ListenerPsPath)
    $hostMarker = '--host-id\s+"?' + [regex]::Escape($WorkerHostId) + '(?:"|\s|$)'
    $relativeListener = '(?i)(?:^|\s)"?(?:\.[/\\])?scripts[/\\]quack-listener\.mjs"?\s+daemon(?:\s|$)'
    $owners = @(Get-CimInstance Win32_Process | Where-Object {
        if ($_.ProcessId -eq $PID -or -not $_.CommandLine) { return $false }
        $command = [string]$_.CommandLine
        $wrapperMatch = @($wrapperPaths | Where-Object { $command.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -gt 0
        $exactListener = $command.IndexOf($ListenerScriptPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $command -match $hostMarker
        $wrapperMatch -or $exactListener -or $command -match $relativeListener
    })
    if ($owners.Count -gt 0) {
        $ownerIds = ($owners | ForEach-Object { $_.ProcessId }) -join ', '
        throw "Worker installation refused: matching or unscoped listener processes are active (PID $ownerIds). Stop the intended worker explicitly and resolve unscoped listeners before retrying. No process was stopped."
    }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) {
        $ownerIds = ($listeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
        throw "Worker installation refused: port $Port is occupied (PID $ownerIds). Stop the intended runtime explicitly before retrying. No process was stopped."
    }
}

function Escape-PowerShellLiteral {
    param([string] $Value)
    return $Value.Replace("'", "''")
}

function Wait-ForHealth {
    param(
        [string] $Url,
        [int] $TimeoutSeconds = 45
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Seconds 2
        try {
            $response = curl.exe -s "$Url/api/health"
            if ($response) {
                return $response
            }
        } catch {
        }
    } while ((Get-Date) -lt $deadline)

    return $null
}

function Install-RunKey {
    param(
        [string] $Name,
        [string] $Command
    )

    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    New-Item -Path $runKey -Force | Out-Null
    Set-ItemProperty -Path $runKey -Name $Name -Value $Command
}

function Try-InstallScheduledTask {
    param(
        [string] $TaskName,
        [string] $Execute,
        [string] $Arguments,
        [string] $Description,
        [ValidateSet("AtLogOn", "AtStartup")]
        [string] $TriggerMode = "AtLogOn"
    )

    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 72) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $action = New-ScheduledTaskAction -Execute $Execute -Argument $Arguments
    if ($TriggerMode -eq "AtStartup") {
        $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
        $trigger = New-ScheduledTaskTrigger -AtStartup
    } else {
        $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
        $trigger = New-ScheduledTaskTrigger -AtLogOn
    }

    try {
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $Description -Force -ErrorAction Stop | Out-Null
        return $true
    } catch {
        return $false
    }
}

$RepoPath = Resolve-RepoPath -Value $RepoPath
$PrimaryProjectPath = (Resolve-Path -LiteralPath $PrimaryProjectPath).Path
$Alias = if ($Alias) { $Alias } else { $HostId }
$ListenerBaseUrl = Resolve-TailscaleUrl -Existing $ListenerBaseUrl -Port $MonitorPort
$LocalMonitorUrl = Resolve-LocalRuntimeUrl -Existing $LocalMonitorUrl -Port $MonitorPort

$runtimeDir = Join-Path $RepoPath ".quack\runtime-logs"
$envFile = Join-Path $RepoPath (".quack\" + $HostId + "-worker.env")
$capabilityReportFile = if ($CapabilityReportPath) { $CapabilityReportPath } else { Join-Path $RepoPath (".quack\" + $HostId + "-capabilities.json") }
$monitorCmd = Join-Path $RepoPath (".quack\run-" + $HostId + "-runtime.cmd")
$monitorPs = Join-Path $RepoPath (".quack\run-" + $HostId + "-runtime.ps1")
$listenerPs = Join-Path $RepoPath (".quack\run-" + $HostId + "-listener.ps1")
$monitorOutLog = Join-Path $runtimeDir ($HostId + "-runtime.out.log")
$monitorErrLog = Join-Path $runtimeDir ($HostId + "-runtime.err.log")
$listenerOutLog = Join-Path $runtimeDir ($HostId + "-listener.out.log")
$listenerErrLog = Join-Path $runtimeDir ($HostId + "-listener.err.log")
$peerConfigDir = Join-Path $PrimaryProjectPath ".quack\federation"
$peerConfigPath = Join-Path $peerConfigDir "peer.json"

Assert-WorkerStopped -RuntimeCmdPath $monitorCmd -RuntimePsPath $monitorPs -ListenerPsPath $listenerPs -ListenerScriptPath (Join-Path $RepoPath "scripts\quack-listener.mjs") -WorkerHostId $HostId -Port $MonitorPort

Ensure-Directory -Path $runtimeDir

$projectMap = [ordered]@{}
$projectMap[$PrimaryProjectKey] = $PrimaryProjectPath
if ($PrimaryProjectAlias -and $PrimaryProjectAlias -ne $PrimaryProjectKey) {
    $projectMap[$PrimaryProjectAlias] = $PrimaryProjectPath
}
$projectMap["quack"] = $RepoPath
$projectPathsJson = $projectMap | ConvertTo-Json -Compress
$posixToolchain = Resolve-WindowsPosixToolchain

$envLines = @(
    "QUACK_BASE_URL=$ControlBaseUrl"
    "QUACK_SERVICE_TOKEN=$ServiceToken"
    "QUACK_HOST_ID=$HostId"
    "QUACK_ALIAS=$Alias"
    "QUACK_LISTENER_BASE_URL=$ListenerBaseUrl"
    "QUACK_CAPABILITIES=$Capabilities"
    "QUACK_REQUESTED_CAPABILITIES=$RequestedCapabilities"
    "QUACK_REPO_PATH=$RepoPath"
    "QUACK_LOCAL_RUNTIME_URL=$LocalMonitorUrl"
    "QUACK_MAX_CONCURRENT_JOBS=$MaxConcurrentJobs"
    "QUACK_WORKER_POLL_MS=$WorkerPollMs"
    "QUACK_PROJECT_PATHS_JSON=$projectPathsJson"
    "QUACK_CAPABILITY_REPORT_PATH=$capabilityReportFile"
)
if ($posixToolchain.BashPath) {
    $envLines += "QUACK_BASH_PATH=$($posixToolchain.BashPath)"
}
if ($posixToolchain.PosixBinDirs.Count -gt 0) {
    $envLines += "QUACK_POSIX_BIN_DIR=$($posixToolchain.PosixBinDirs -join ';')"
    $envLines += "QUACK_POSIX_BIN_DIR_ONLY=true"
}
[System.IO.File]::WriteAllLines($envFile, [string[]] $envLines, (New-Object System.Text.UTF8Encoding($false)))

if (-not (Test-Path -LiteralPath $capabilityReportFile)) {
    $capabilityReport = [ordered]@{
        requestedCapabilities = @($RequestedCapabilities -split "," | Where-Object { $_ })
        advertisedCapabilities = @($Capabilities -split "," | Where-Object { $_ })
        windowsPersistence = [ordered]@{
            hostId = $HostId
            monitorPort = $MonitorPort
            requestedMode = $Persistence
            localRuntimeUrl = $LocalMonitorUrl
            listenerBaseUrl = $ListenerBaseUrl
        }
        readinessNote = "Capability readiness is normally written by quack worker install before this Windows persistence helper runs."
        updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    }
    $capabilityReportJson = ($capabilityReport | ConvertTo-Json -Depth 8) + "`n"
    [System.IO.File]::WriteAllText(
        $capabilityReportFile,
        $capabilityReportJson,
        (New-Object System.Text.UTF8Encoding($false))
    )
}

if (-not $posixToolchain.BashPath -or $posixToolchain.PosixBinDirs.Count -eq 0) {
    Write-Warning "Git Bash / POSIX verification tooling was not detected. Dispatch/verify/fix capabilities may be withheld until you install Git for Windows or set QUACK_BASH_PATH and QUACK_POSIX_BIN_DIR. See docs/TROUBLESHOOTING.md for supported shell configuration."
}

Ensure-Directory -Path $peerConfigDir
$remoteProjectId = if ($PrimaryProjectAlias) { $PrimaryProjectAlias } else { $PrimaryProjectKey }
$peerConfig = [ordered]@{
    url = $ControlBaseUrl
    remoteProjectId = $remoteProjectId
    serviceTokenEnv = "QUACK_SERVICE_TOKEN"
    syncIntervalMs = 300000
    syncOnStartup = $true
    pushOnWrite = $false
    limit = 250
}
$peerConfigJson = ($peerConfig | ConvertTo-Json -Depth 4) + "`n"
[System.IO.File]::WriteAllText(
    $peerConfigPath,
    $peerConfigJson,
    (New-Object System.Text.UTF8Encoding($false))
)

$monitorPsBody = @'
$ErrorActionPreference = 'Stop'
$RepoPath = '__REPO_PATH__'
$PrimaryProjectPath = '__PRIMARY_PROJECT__'
$EnvFile = '__ENV_FILE__'
$OutLog = '__OUT_LOG__'
$ErrLog = '__ERR_LOG__'
$Node = 'C:\Program Files\nodejs\node.exe'

function Import-EnvFile($Path) {
  foreach ($line in Get-Content -Path $Path -Encoding utf8 -ErrorAction Stop) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    if ($line.TrimStart().StartsWith('#')) { continue }
    $idx = $line.IndexOf('=')
    if ($idx -lt 1) { continue }
    $name = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1)
    Set-Item -Path ("Env:" + $name) -Value $value
  }
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutLog) | Out-Null
if (-not (Test-Path -LiteralPath $Node)) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $Node = $nodeCmd.Source
  }
}
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
Set-Location -LiteralPath $RepoPath
Import-EnvFile -Path $EnvFile
if (@(Get-NetTCPConnection -State Listen -LocalPort '__PORT__' -ErrorAction SilentlyContinue).Count -gt 0) {
  throw 'Worker runtime port is already occupied. Stop the intended runtime explicitly; no process was stopped.'
}
"Quack worker runtime starting at $(Get-Date -Format o)" | Out-File -FilePath $OutLog -Encoding utf8 -Append
& $Node '.\dist\index.js' worker-runtime --host '127.0.0.1' --port '__PORT__' --project $PrimaryProjectPath --project $RepoPath >> $OutLog 2>> $ErrLog
"Quack worker runtime exited at $(Get-Date -Format o) exit=$LASTEXITCODE" | Out-File -FilePath $OutLog -Encoding utf8 -Append
'@
$monitorPsBody = $monitorPsBody.Replace("__REPO_PATH__", (Escape-PowerShellLiteral $RepoPath)).Replace("__PRIMARY_PROJECT__", (Escape-PowerShellLiteral $PrimaryProjectPath)).Replace("__ENV_FILE__", (Escape-PowerShellLiteral $envFile)).Replace("__OUT_LOG__", (Escape-PowerShellLiteral $monitorOutLog)).Replace("__ERR_LOG__", (Escape-PowerShellLiteral $monitorErrLog)).Replace("__PORT__", [string]$MonitorPort)
Set-Content -Path $monitorPs -Value $monitorPsBody -Encoding utf8

$monitorCmdBody = @(
    "@echo off"
    "setlocal"
    'cd /d "%~dp0.."'
    ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-' + $HostId + '-runtime.ps1"')
)
Set-Content -Path $monitorCmd -Value $monitorCmdBody -Encoding ascii

$listenerPsBody = @'
$ErrorActionPreference = 'Stop'
$RepoPath = '__REPO_PATH__'
$EnvFile = '__ENV_FILE__'
$OutLog = '__OUT_LOG__'
$ErrLog = '__ERR_LOG__'
$Node = 'C:\Program Files\nodejs\node.exe'

function Import-EnvFile($Path) {
  foreach ($line in Get-Content -Path $Path -Encoding utf8 -ErrorAction Stop) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    if ($line.TrimStart().StartsWith('#')) { continue }
    $idx = $line.IndexOf('=')
    if ($idx -lt 1) { continue }
    $name = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1)
    Set-Item -Path ("Env:" + $name) -Value $value
  }
}

if (-not (Test-Path -LiteralPath $Node)) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $Node = $nodeCmd.Source
  }
}
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path
Set-Location -LiteralPath $RepoPath
Import-EnvFile -Path $EnvFile
Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $PID -and $_.CommandLine -and
  ([string]$_.CommandLine).IndexOf('__LISTENER_SCRIPT__', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
  $_.CommandLine -match ('--host-id\s+"?' + [regex]::Escape('__HOST_ID__') + '(?:"|\s|$)')
} | ForEach-Object {
  throw ('Worker listener is already active (PID ' + $_.ProcessId + '). Stop it explicitly; no process was stopped.')
}
"Quack worker listener starting at $(Get-Date -Format o)" | Out-File -FilePath $OutLog -Encoding utf8 -Append
& $Node '__LISTENER_SCRIPT__' daemon --host-id '__HOST_ID__' >> $OutLog 2>> $ErrLog
"Quack worker listener exited at $(Get-Date -Format o) exit=$LASTEXITCODE" | Out-File -FilePath $OutLog -Encoding utf8 -Append
'@
$listenerPsBody = $listenerPsBody.Replace("__REPO_PATH__", (Escape-PowerShellLiteral $RepoPath)).Replace("__ENV_FILE__", (Escape-PowerShellLiteral $envFile)).Replace("__OUT_LOG__", (Escape-PowerShellLiteral $listenerOutLog)).Replace("__ERR_LOG__", (Escape-PowerShellLiteral $listenerErrLog)).Replace("__LISTENER_SCRIPT__", (Escape-PowerShellLiteral (Join-Path $RepoPath "scripts\quack-listener.mjs"))).Replace("__HOST_ID__", (Escape-PowerShellLiteral $HostId))
Set-Content -Path $listenerPs -Value $listenerPsBody -Encoding utf8

$monitorMode = "manual"
$listenerMode = "manual"
$monitorTaskName = "QuackWorkerRuntime-$HostId"
$listenerTaskName = "QuackWorkerListener-$HostId"
$scheduledTaskTriggerMode = if ($Persistence -eq "ScheduledTaskStartup") { "AtStartup" } else { "AtLogOn" }

if (-not $SkipMonitorInstall) {
    if ($Persistence -eq "ScheduledTaskLogon" -or $Persistence -eq "ScheduledTaskStartup" -or $Persistence -eq "Auto") {
        if (
            Try-InstallScheduledTask `
                -TaskName $monitorTaskName `
                -Execute "powershell.exe" `
                -Arguments ('-NoProfile -ExecutionPolicy Bypass -File "' + $monitorPs + '"') `
                -Description ("Quack worker runtime for " + $HostId) `
                -TriggerMode $scheduledTaskTriggerMode
        ) {
            $monitorMode = if ($scheduledTaskTriggerMode -eq "AtStartup") { "scheduled-task-startup" } else { "scheduled-task-logon" }
        }
    }

    if ($monitorMode -eq "manual" -and ($Persistence -eq "RunKey" -or $Persistence -eq "Auto")) {
        Install-RunKey -Name $monitorTaskName -Command ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $monitorPs + '"')
        $monitorMode = "run-key"
    }
}

if ($Persistence -eq "ScheduledTaskLogon" -or $Persistence -eq "ScheduledTaskStartup") {
    if (
        Try-InstallScheduledTask `
            -TaskName $listenerTaskName `
            -Execute "powershell.exe" `
            -Arguments ('-NoProfile -ExecutionPolicy Bypass -File "' + $listenerPs + '"') `
            -Description ("Quack worker listener for " + $HostId) `
            -TriggerMode $scheduledTaskTriggerMode
    ) {
        $listenerMode = if ($scheduledTaskTriggerMode -eq "AtStartup") { "scheduled-task-startup" } else { "scheduled-task-logon" }
    } else {
        throw "Failed to register scheduled task $listenerTaskName."
    }
} elseif ($Persistence -eq "RunKey") {
    Install-RunKey -Name $listenerTaskName -Command ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $listenerPs + '"')
    $listenerMode = "run-key"
} else {
    if (
        Try-InstallScheduledTask `
            -TaskName $listenerTaskName `
            -Execute "powershell.exe" `
            -Arguments ('-NoProfile -ExecutionPolicy Bypass -File "' + $listenerPs + '"') `
            -Description ("Quack worker listener for " + $HostId) `
            -TriggerMode "AtLogOn"
    ) {
        $listenerMode = "scheduled-task-logon"
    } else {
        Install-RunKey -Name $listenerTaskName -Command ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + $listenerPs + '"')
        $listenerMode = "run-key"
    }
}

if (-not $SkipMonitorInstall -and -not $NoStart) {
    Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $monitorPs + '"'))
    $monitorHealth = Wait-ForHealth -Url $LocalMonitorUrl
} else {
    $monitorHealth = $null
}

if (-not $NoStart) {
    Import-EnvFile -Path $envFile
    Set-Location -LiteralPath $RepoPath
    & node .\scripts\quack-listener.mjs once --json | Out-Host
    Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $listenerPs + '"'))
}

Write-Host
Write-Host ("Worker install complete for host-id " + $HostId)
Write-Host ("  Repo:           " + $RepoPath)
Write-Host ("  Control base:   " + $ControlBaseUrl)
Write-Host ("  Listener URL:   " + $ListenerBaseUrl)
Write-Host ("  Local runtime:  " + $LocalMonitorUrl)
Write-Host ("  POSIX shell:    " + ($(if ($posixToolchain.BashPath) { $posixToolchain.BashPath } else { "not detected" })))
Write-Host ("  POSIX bins:     " + ($(if ($posixToolchain.PosixBinDirs.Count -gt 0) { $posixToolchain.PosixBinDirs -join ';' } else { "not detected" })))
Write-Host ("  Peer config:    " + $peerConfigPath)
Write-Host ("  Capability report: " + $capabilityReportFile)
Write-Host ("  Runtime persistence: " + $monitorMode)
Write-Host ("  Listener persistence: " + $listenerMode)
Write-Host
if ($monitorMode -eq "scheduled-task-startup" -or $listenerMode -eq "scheduled-task-startup") {
    Write-Host "Startup contract: boot-capable scheduled task"
    Write-Host "Scheduled-task trigger: AtStartup (SYSTEM)"
    Write-Host "Pre-login availability: true"
    Write-Host "Privilege requirement: scheduled task must be registered successfully with the SYSTEM service account"
} else {
    Write-Host "Startup contract: logon-only"
    if ($monitorMode -eq "scheduled-task-logon" -or $listenerMode -eq "scheduled-task-logon") {
        Write-Host "Scheduled-task trigger: AtLogOn (interactive)"
    }
    Write-Host "Pre-login availability: false"
    Write-Host "Service-mode follow-up required for boot-before-logon startup"
}
if ($monitorHealth) {
    Write-Host
    Write-Host "Runtime health:"
    Write-Host $monitorHealth
}
