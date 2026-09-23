<#
.SYNOPSIS
    Registers the Sajan Shree Tally WhatsApp companion to start automatically.

.DESCRIPTION
    Uses Windows Task Scheduler rather than a true Windows Service.

    Why: a real service needs a wrapper (nssm, node-windows) - another dependency
    to install and keep current on a till PC. A scheduled task is built into
    Windows, needs nothing extra, survives reboots, and restarts on failure.

    The task runs AT LOGON as the interactive user, deliberately, not as SYSTEM:
    the companion only ever talks to 127.0.0.1 and needs no privilege, and running
    it unprivileged means a compromise of it gains nothing.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\install-service.ps1
    powershell -ExecutionPolicy Bypass -File .\install-service.ps1 -Uninstall
#>

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [string]$TaskName = "SajanShree Tally WhatsApp Companion"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$entryPoint = Join-Path $scriptDir "companion.js"
$configFile = Join-Path $scriptDir "config.json"

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task: $TaskName"
    } else {
        Write-Host "No such scheduled task: $TaskName"
    }
    # The Startup-folder fallback is a separate mechanism; remove it too or the
    # companion keeps starting after an apparently successful uninstall.
    $vbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'SajanShreeTallyCompanion.vbs'
    if (Test-Path $vbs) { Remove-Item $vbs -Force; Write-Host "Removed startup launcher: $vbs" }
    return
}

# --- preflight: fail loudly here rather than silently at 9am tomorrow ---------

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    throw "Node.js is not on PATH. Install Node 18 or newer, then re-run this script."
}

$nodeVersion = (& $node --version).TrimStart('v')
if ([int]($nodeVersion -split '\.')[0] -lt 18) {
    throw "Node $nodeVersion is too old. The companion uses built-in fetch, which needs Node 18+."
}

if (-not (Test-Path $entryPoint)) { throw "Cannot find companion.js at $entryPoint" }

if (-not (Test-Path $configFile)) {
    throw @"
Missing config.json at $configFile
Copy config.example.json to config.json and fill in apiBaseUrl and apiKey first.
"@
}

# Refuse to install a config still pointing at a local test stub - this is the
# mistake that looks like "it works" in testing and silently sends nothing live.
$config = Get-Content $configFile -Raw | ConvertFrom-Json
if ($config.apiBaseUrl -match '127\.0\.0\.1|localhost') {
    throw "config.json apiBaseUrl is still '$($config.apiBaseUrl)' - point it at the real backend before installing."
}
if ([string]::IsNullOrWhiteSpace($config.apiKey) -or $config.apiKey -match 'paste|test|example') {
    throw "config.json apiKey is not a real key. Set the TALLY_API_KEY from the backend .env."
}

Write-Host "Node       : $node ($nodeVersion)"
Write-Host "Companion  : $entryPoint"
Write-Host "Forwarding : $($config.apiBaseUrl)"

# --- register ----------------------------------------------------------------

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Task already exists - replacing it."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute $node -Argument "`"$entryPoint`"" -WorkingDirectory $scriptDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

# StartWhenAvailable + restart-on-failure: the till loses power and gets switched
# on again far more often than a server does.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

# Register-ScheduledTask needs elevation. A till is usually a standard account,
# so fall back to the Startup folder rather than failing: it needs no admin
# rights, starts at logon just the same, and is one file to delete to undo.
# Without a fallback the operator is left with an uninstalled companion and an
# "Access is denied" message, and invoices stop the next time the PC reboots.
$registered = $false
try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Description `
        "Forwards TallyPrime sales invoices to the Sajan Shree backend for WhatsApp notification." `
        -ErrorAction Stop | Out-Null
    $registered = $true
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Registered as a scheduled task."
} catch {
    Write-Host "Could not register a scheduled task ($($_.Exception.Message.Trim()))."
    Write-Host "Falling back to the Startup folder, which needs no admin rights."

    $startup = [Environment]::GetFolderPath('Startup')
    $vbs = Join-Path $startup 'SajanShreeTallyCompanion.vbs'
    # Window style 0: no console window at all. A stray black window on a till
    # is an invitation for someone to close it.
    $launcher = @"
' Starts the Sajan Shree Tally WhatsApp companion at logon, with no visible window.
' Delete this file to stop it starting.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$scriptDir"
sh.Run """$node"" companion.js", 0, False
"@
    [System.IO.File]::WriteAllText($vbs, $launcher, (New-Object System.Text.ASCIIEncoding))
    Write-Host "Created $vbs"
    & wscript.exe $vbs
}

Start-Sleep -Seconds 4

# --- verify it actually came up ----------------------------------------------

$port = if ($config.port) { $config.port } else { 5111 }
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 5
    Write-Host ""
    Write-Host "Installed and running. Health: queued=$($health.queued) forwarding to $($health.apiBaseUrl)"
} catch {
    $how = if ($registered) { "Task registered" } else { "Startup launcher created" }
    Write-Warning "$how, but nothing is answering on 127.0.0.1:$port."
    Write-Warning "Check $scriptDir\companion.log, or run 'node companion.js' by hand to see the error."
}
