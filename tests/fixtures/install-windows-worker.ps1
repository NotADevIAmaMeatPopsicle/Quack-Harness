$ErrorActionPreference = 'Stop'
$ctx = Get-Content -LiteralPath $env:QUACK_INSTALL_FIXTURE_CONTEXT -Encoding utf8 -Raw | ConvertFrom-Json
$events = New-Object 'System.Collections.Generic.List[object]'
$launches = New-Object 'System.Collections.Generic.List[object]'
$listenerCalls = New-Object 'System.Collections.Generic.List[object]'
$healthCalls = New-Object 'System.Collections.Generic.List[object]'
$importedEnvironments = New-Object 'System.Collections.Generic.List[object]'
$parsedWrappers = 0
$failure = $null

function Get-CimInstance {
    if ($ctx.scenario -eq 'owned-wrapper') {
        [pscustomobject]@{ProcessId=424242;CommandLine=('powershell.exe -File "' + (Join-Path $ctx.repo '.quack\run-fixture-host-listener.ps1') + '"')}
    } elseif ($ctx.scenario -eq 'unscoped-listener') {
        [pscustomobject]@{ProcessId=424242;CommandLine='node .\scripts\quack-listener.mjs daemon'}
    } elseif ($ctx.scenario -eq 'other-worker') {
        [pscustomobject]@{ProcessId=424242;CommandLine='node "C:\unrelated\scripts\quack-listener.mjs" daemon --host-id another-host'}
    }
}
function Get-NetTCPConnection {
    if ($ctx.scenario -eq 'busy-port') { [pscustomobject]@{OwningProcess=424242} }
}
function Stop-Process { throw 'Fixture forbids process termination.' }
function Start-Process {
    param($FilePath,$WindowStyle,$ArgumentList)
    if ($ctx.scenario -ne 'start') { throw 'Fixture forbids unexpected process startup.' }
    $launches.Add([pscustomobject]@{filePath=$FilePath;windowStyle=$WindowStyle;arguments=@($ArgumentList);commandLine=($ArgumentList -join ' ')})
}
function Read-ImportedEnvironment {
    param($Source)
    [pscustomobject]@{source=$Source;repoPath=$env:QUACK_REPO_PATH;projectPaths=($env:QUACK_PROJECT_PATHS_JSON|ConvertFrom-Json);capabilityReportPath=$env:QUACK_CAPABILITY_REPORT_PATH}
}
function node {
    if ($ctx.scenario -ne 'start') { throw 'Fixture forbids unexpected node execution.' }
    $listenerCalls.Add(@($args))
    $importedEnvironments.Add((Read-ImportedEnvironment 'immediate-listener'))
    '{"ok":true}'
}
function curl.exe {
    if ($ctx.scenario -ne 'start') { throw 'Fixture forbids unexpected network access.' }
    $healthCalls.Add(@($args))
    '{"ok":true}'
}
function Start-Sleep {
    param($Seconds)
    if ($ctx.scenario -ne 'start' -or $Seconds -ne 2) { throw 'Fixture forbids unexpected waits.' }
}
function Set-ItemProperty { throw 'Fixture forbids registry writes.' }
function New-ScheduledTaskSettingsSet { [pscustomobject]@{} }
function New-ScheduledTaskAction {
    param($Execute,$Argument)
    [pscustomobject]@{execute=$Execute;arguments=$Argument}
}
function New-ScheduledTaskPrincipal { [pscustomobject]@{} }
function New-ScheduledTaskTrigger {
    param([switch]$AtStartup,[switch]$AtLogOn)
    if ($AtStartup) { 'startup' } else { 'logon' }
}
function Register-ScheduledTask {
    param($TaskName,$Action,$Trigger,$Principal,$Settings,$Description,[switch]$Force,$ErrorAction)
    $events.Add([pscustomobject]@{taskName=$TaskName;execute=$Action.execute;arguments=$Action.arguments;trigger=$Trigger})
}

try {
    $tokens=$null;$errors=$null
    [System.Management.Automation.Language.Parser]::ParseFile($ctx.script,[ref]$tokens,[ref]$errors) | Out-Null
    if ($errors.Count -gt 0) { throw ($errors.Message -join '; ') }
    $noStart = $ctx.scenario -ne 'start'
    & $ctx.script -HostId fixture-host -Alias fixture -ServiceToken fixture-token -PrimaryProjectPath $ctx.project -ControlBaseUrl http://127.0.0.1:3333 -RepoPath $ctx.repo -PrimaryProjectKey example -PrimaryProjectAlias example-alias -ListenerBaseUrl http://127.0.0.1:3337 -LocalMonitorUrl http://127.0.0.1:3337 -MonitorPort 3337 -Persistence ScheduledTaskLogon -NoStart:$noStart
    foreach ($wrapper in Get-ChildItem -LiteralPath (Join-Path $ctx.repo '.quack') -Filter '*.ps1') {
        $tokens=$null;$errors=$null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($wrapper.FullName,[ref]$tokens,[ref]$errors)
        if ($errors.Count -gt 0) { throw ('Generated wrapper did not parse: ' + ($errors.Message -join '; ')) }
        $parsedWrappers++
        if ($ctx.scenario -eq 'start') {
            # Execute only the generated reader, never the wrapper's process body.
            $reader = $ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Import-EnvFile'},$true)
            if (-not $reader) { throw 'Generated wrapper is missing its environment reader.' }
            & {
                param($Definition,$EnvFile,$Source)
                . ([scriptblock]::Create($Definition))
                Import-EnvFile $EnvFile
                $importedEnvironments.Add((Read-ImportedEnvironment $Source))
            } $reader.Extent.Text (Join-Path $ctx.repo '.quack\fixture-host-worker.env') $wrapper.Name
        }
    }
} catch { $failure=$_.Exception.Message }
$result=[ordered]@{error=$failure;events=@($events.ToArray());launches=@($launches.ToArray());listenerCalls=@($listenerCalls.ToArray());healthCalls=@($healthCalls.ToArray());importedEnvironments=@($importedEnvironments.ToArray());parsedWrappers=$parsedWrappers}
[System.IO.File]::WriteAllText($ctx.resultFile,($result|ConvertTo-Json -Depth 7),(New-Object System.Text.UTF8Encoding($false)))
if ($failure) { exit 1 }
