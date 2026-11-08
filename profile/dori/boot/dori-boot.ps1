# Dori autostart: runs at Windows logon (scheduled task "<Name> Autostart", registered by profile/install-profile.ps1).
# Opens herdr in Windows Terminal, creates a herdr workspace named after the Dori, writes its ids into ~/.dori/config.json
# (leadPane, laneWorkspace, workspaces, ignorePanes) and starts a fresh Dori session there with config.agentCommand.
# The messenger is DORI_MESSENGER, else the first of slack.env, telegram.env, discord.env in ~/.dori that holds a token.
# Skips everything if an omo session already runs.
# The Dori's name comes from DORI_NAME, else "name" in config.json, else "Dori".
# -Herdr and -NoLaunch are test seams: a fake herdr, and no omo check / Windows Terminal / agent start.
param([string]$Herdr = 'herdr', [switch]$NoLaunch)
$ErrorActionPreference = 'Continue'
$doriHome = if ($env:DORI_HOME) { $env:DORI_HOME } else { Join-Path $env:USERPROFILE '.dori' }
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

# herdr: a visible client in Windows Terminal (it starts the server).
if (-not $NoLaunch -and -not (Get-Process -Name herdr -ErrorAction SilentlyContinue)) {
    Start-Process wt.exe -ArgumentList 'herdr'
    Log 'herdr client opened in Windows Terminal'
}
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

# This PC's herdr ids: the new pane is the lead, lanes open as tabs in its workspace.
foreach ($kv in @(@('leadPane', $pane), @('laneWorkspace', $workspace), @('workspaces', @($workspace)), @('ignorePanes', @($pane)))) {
    $config | Add-Member -NotePropertyName $kv[0] -NotePropertyValue $kv[1] -Force
}
$json = $config | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText($configPath, $json + "`n", (New-Object Text.UTF8Encoding $false))
Log "config.json: leadPane=$pane laneWorkspace=$workspace"

$model = if ($config.defaultModel) { [string]$config.defaultModel } else { 'anthropic/claude-opus-5-5' }
$agentCommand = if ($config.agentCommand) { @($config.agentCommand | ForEach-Object { [string]$_ }) } else { @('omo', '--model', '{model}', '{prompt}') }
function Read-EnvFile([string]$M) {
    $v = @{}
    $f = Join-Path $doriHome "$M.env"
    if (Test-Path -LiteralPath $f) {
        foreach ($l in Get-Content -LiteralPath $f -Encoding utf8) { $i = $l.IndexOf('='); if ($i -gt 0) { $v[$l.Substring(0, $i).Trim()] = $l.Substring($i + 1).Trim() } }
    }
    $v
}
$messenger = if ($env:DORI_MESSENGER) { $env:DORI_MESSENGER.ToLowerInvariant() } else { '' }
if (-not $messenger) {
    foreach ($m in 'slack', 'telegram', 'discord') { if ((Read-EnvFile $m)["DORI_$($m.ToUpperInvariant())_TOKEN"]) { $messenger = $m; break } }
}
$envVals = if ($messenger) { Read-EnvFile $messenger } else { @{} }
$readyLine = 'saying you restarted automatically after the reboot and are ready. '
$lang = 'in the language the owner uses with you, '
switch ($messenger) {
    'slack' {
        $inbound = if ([string]$envVals['DORI_SLACK_TOKEN'] -like 'xoxb-*') { 'the Slack listener (DELIVERY=stdout bun ~/.dori/inbound-next/run-inbound.ts, filter ^INBOUND)' } else { 'the Slack inbound poll (dori inbound slack --loop 1, filter ^INBOUND)' }
        $channel = [string]$envVals['DORI_SLACK_CHANNEL']
        $post = if ($channel) { "post one short line to Slack channel $channel (top level), $lang$readyLine" } else { "post one short line to the owner on Slack, $lang$readyLine" }
    }
    'telegram' {
        $inbound = 'the Telegram inbound poll (dori inbound telegram --loop 1, filter ^INBOUND)'
        $owner = [string]$envVals['DORI_TELEGRAM_OWNER']
        $post = "send one short message to the owner on Telegram$(if ($owner) { " (chat $owner)" }), $lang$readyLine"
    }
    'discord' {
        $inbound = 'your Discord watch command (agent-messenger; see Monitors in the dori-mode skill references/setup.md)'
        $owner = [string]$envVals['DORI_DISCORD_OWNER']
        $post = "send one short message to the owner on Discord$(if ($owner) { " (user $owner)" }), $lang$readyLine"
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
  "The boot script already wrote this PC's herdr ids into ~/.dori/config.json (leadPane $pane, laneWorkspace $workspace); check them with herdr pane current. " +
  'Then ' + $post +
  'After that, wait for messages.'
if ($NoLaunch) { Log 'NoLaunch: agent not started'; Write-Output "BOOT_OK pane=$pane workspace=$workspace name=$name messenger=$messenger"; exit 0 }
Start-Sleep -Seconds 3
$argv = foreach ($part in $agentCommand) { "'" + $part.Replace('{model}', $model).Replace('{prompt}', $prompt).Replace("'", "''") + "'" }
$line = '& ' + ($argv -join ' ')
& $Herdr pane run $pane $line *> $null
Log "$name session started in pane $pane"
exit 0
