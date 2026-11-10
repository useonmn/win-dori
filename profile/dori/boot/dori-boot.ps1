# Dori autostart: runs at Windows logon (scheduled task "<Name> Autostart", registered by profile/install-profile.ps1).
# Opens herdr in Windows Terminal, creates a herdr workspace named after the Dori, writes its ids into ~/.dori/config.json
# (leadPane, laneWorkspace, workspaces, ignorePanes) and starts a fresh Dori session there with config.agentCommand.
# The messenger is DORI_MESSENGER (slack, telegram or discord), else slack when DORI_SLACK_TOKEN is set, else telegram
# when DORI_TELEGRAM_TOKEN is set (user environment variables, as the dori-mode skill setup documents).
# Skips everything if an omo session already runs.
# The Dori's name comes from DORI_NAME, else "name" in config.json, else "Dori".
# The runtime is DORI_RUNTIME, else "runtime" in config.json, else herdr. With hc (herdr-core) the lead is an hc terminal
# labelled dori.group=<name> and dori.role=lead, shown with hc attach in Windows Terminal; leadPane is its address.
# -Herdr, -Hc and -NoLaunch are test seams: a fake herdr or hc, and no omo check / Windows Terminal / agent start.
param([string]$Herdr = 'herdr', [string]$Hc = 'hc', [switch]$NoLaunch)
$ErrorActionPreference = 'Continue'
$doriHome = Join-Path $env:USERPROFILE '.dori'
$stateDir = Join-Path $doriHome 'state'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$log = Join-Path $stateDir 'boot.log'
function Log([string]$m) { "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m | Add-Content -Path $log -Encoding utf8 }

Log 'boot start'
if (-not $NoLaunch -and (Get-Process -Name omo -ErrorAction SilentlyContinue)) { Log 'omo already running; nothing to do'; exit 0 }

$configPath = Join-Path $doriHome 'config.json'
$config = if (Test-Path -LiteralPath $configPath) { Get-Content -LiteralPath $configPath -Raw -Encoding utf8 | ConvertFrom-Json } else { [pscustomobject]@{} }
$name = if ($env:DORI_NAME) { $env:DORI_NAME } elseif ($config.name) { [string]$config.name } else { 'Dori' }
$label = ($name.ToLowerInvariant() -replace '[^\w-]+', '-').Trim('-')
if (-not $label) { $label = 'dori' }

$runtime = if ($env:DORI_RUNTIME) { $env:DORI_RUNTIME } elseif ($config.runtime) { [string]$config.runtime } else { 'herdr' }
if ($runtime -eq 'hc') {
    # The core starts on the first call; the lead runs the user's shell (hc's default: PowerShell 7, else 5.1).
    & $Hc --json server status *> $null
    $created = & $Hc --json run --bg --no-parent --no-notify --cwd $env:USERPROFILE --name $label --label "dori.group=$label" --label 'dori.role=lead' | Out-String
    if (-not ($created -match '"address":"(t[0-9a-z]+)"')) {
        # The name is taken by a live terminal (an earlier boot) or is not a valid hc name (non-ASCII): an unnamed terminal, still labelled.
        $created = & $Hc --json run --bg --no-parent --no-notify --cwd $env:USERPROFILE --label "dori.group=$label" --label 'dori.role=lead' | Out-String
    }
    $pane = ([regex]::Match($created, '"address":"(t[0-9a-z]+)"')).Groups[1].Value
    $workspace = $label
    if (-not $pane) { Log "hc run failed: $created"; exit 1 }
    if (-not $NoLaunch) { Start-Process wt.exe -ArgumentList 'hc', 'attach', $pane; Log "hc attach $pane opened in Windows Terminal" }
}
# herdr: a visible client in Windows Terminal (it starts the server).
if ($runtime -ne 'hc' -and -not $NoLaunch -and -not (Get-Process -Name herdr -ErrorAction SilentlyContinue)) {
    Start-Process wt.exe -ArgumentList 'herdr'
    Log 'herdr client opened in Windows Terminal'
}
if ($runtime -ne 'hc') {
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        & $Herdr workspace list *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $ready) { Log 'herdr server not reachable after 120 s; giving up'; exit 1 }

    $created = & $Herdr workspace create --label $label --cwd $env:USERPROFILE --no-focus | Out-String
    $pane = ([regex]::Match($created, '"pane_id":"([^"]+)"')).Groups[1].Value
    $workspace = ([regex]::Match($created, '"workspace_id":"([^"]+)"')).Groups[1].Value
    if (-not $workspace -and $pane -match '^([^:]+):') { $workspace = $Matches[1] }
    if (-not $pane) { Log "workspace create failed: $created"; exit 1 }
}

# This PC's session ids: the new session is the lead; lanes open in its workspace (herdr) or group label (hc).
foreach ($kv in @(@('leadPane', $pane), @('laneWorkspace', $workspace), @('workspaces', @($workspace)), @('ignorePanes', @($pane)))) {
    $config | Add-Member -NotePropertyName $kv[0] -NotePropertyValue $kv[1] -Force
}
$json = $config | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText($configPath, $json + "`n", (New-Object Text.UTF8Encoding $false))
Log "config.json: leadPane=$pane laneWorkspace=$workspace"

$model = if ($config.defaultModel) { [string]$config.defaultModel } else { 'anthropic/claude-opus-5-5' }
$agentCommand = if ($config.agentCommand) { @($config.agentCommand | ForEach-Object { [string]$_ }) } else { @('omo', '--model', '{model}', '{prompt}') }
$messenger = if ($env:DORI_MESSENGER) { $env:DORI_MESSENGER.ToLowerInvariant() }
    elseif ($env:DORI_SLACK_TOKEN) { 'slack' }
    elseif ($env:DORI_TELEGRAM_TOKEN) { 'telegram' }
    else { '' }
$readyLine = 'in the language the owner uses with you, saying you restarted automatically after the reboot and are ready. '
switch ($messenger) {
    'slack' {
        $inbound = 'the Slack inbound poll (dori inbound slack --loop 1, filter ^INBOUND)'
        $post = "post one short line to the owner on Slack, $readyLine"
    }
    'telegram' {
        $inbound = 'the Telegram inbound poll (dori inbound telegram --loop 1, filter ^INBOUND)'
        $post = "send one short message to the owner on Telegram, $readyLine"
    }
    'discord' {
        $inbound = "your Discord watch command (see Monitors in the dori-mode skill references/setup.md)"
        $post = "send one short message to the owner on Discord, $readyLine"
    }
    default {
        $messenger = 'none'
        $inbound = 'nothing yet: no messenger is set up, so run the messenger step of the dori-mode skill setup (ask the owner which messenger)'
        $post = 'tell the owner in this pane that no messenger is set up yet. '
    }
}

$prompt = "$name mode. This session was started automatically after the PC rebooted. Start fresh, do not resume. " +
  'First read memory reference/dori/handoff.md, reference/dori/identity.md, reference/dori/operating-rules.md (skip any that do not exist). ' +
  "Then arm every persistent monitor in the handoff table; if there is no handoff note, arm the inbound monitor for $messenger, $inbound, and the monitors in the dori-mode skill setup. " +
  $(if ($runtime -eq 'hc') { "The boot script already wrote this PC's hc ids into ~/.dori/config.json (leadPane $pane, laneWorkspace $workspace, runtime hc); check them with hc get $pane. " } else { "The boot script already wrote this PC's herdr ids into ~/.dori/config.json (leadPane $pane, laneWorkspace $workspace); check them with herdr pane current. " }) +
  'Then ' + $post +
  'After that, wait for messages.'
$argv = foreach ($part in $agentCommand) { "'" + $part.Replace('{model}', $model).Replace('{prompt}', $prompt).Replace("'", "''") + "'" }
$line = '& ' + ($argv -join ' ')
if ($NoLaunch) { Log 'NoLaunch: agent not started'; Write-Output "BOOT_OK pane=$pane workspace=$workspace name=$name messenger=$messenger runtime=$runtime"; Write-Output "BOOT_LINE $line"; exit 0 }
Start-Sleep -Seconds 3
if ($runtime -eq 'hc') {
    # A PowerShell still loading its profile drops what is typed: wait (20 s at most) for its PS ...> prompt.
    for ($i = 0; $i -lt 40; $i++) {
        $screen = & $Hc --json read $pane --lines 0 | Out-String
        if ($screen -match 'PS [^\r\n]*>\s*"') { break }
        Start-Sleep -Milliseconds 500
    }
    # '--' quoted: Windows PowerShell 5.1 drops a bare -- before a native command's arguments.
    & $Hc --json send $pane '--' $line *> $null
} else {
    & $Herdr pane run $pane $line *> $null
}
Log "$name session started in $runtime session $pane"
exit 0
