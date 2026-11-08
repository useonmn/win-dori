# Dori autostart: runs at Windows logon (scheduled task "<Name> Autostart", registered by profile/install-profile.ps1).
# Opens herdr in Windows Terminal, creates a herdr workspace named after the Dori, writes its ids into ~/.dori/config.json
# (leadPane, laneWorkspace, workspaces, ignorePanes) and starts a fresh Dori session there with config.agentCommand.
# The messenger is DORI_MESSENGER, else the first of slack.env, telegram.env, discord.env in ~/.dori that holds a token.
# Skips everything if an omo session already runs.
# The Dori's name comes from DORI_NAME, else "name" in config.json, else "Dori".
# The runtime is DORI_RUNTIME, else "runtime" in config.json, else herdr. With hc (herdr-core) the lead is an hc terminal
# labelled dori.group=<name> and dori.role=lead, shown with hc attach in Windows Terminal; leadPane is its address.
# A second Dori on the same PC: set DORI_HOME to its folder (config.json, state, <messenger>.env there). Its session then gets
# DORI_HOME, DORI_CONFIG, DORI_STATE_DIR and DORI_ENV_FILE set before the agent starts. Optional config keys: "label" (the
# herdr workspace / hc group and terminal name; default: the name, lowercased), "bootCwd" (default: the user's home),
# "bootCommand" (argv like agentCommand, default agentCommand) and "bootPrompt" (replaces the generated prompt).
# With hc, a live terminal labelled dori.group=<label> and dori.role=lead is this Dori's lead: boot leaves it alone when
# the agent (bootCommand's program) runs below its shell, else starts the agent in it; only without one is a new kept
# terminal (hc run --keep) made. That check is per Dori, so two Doris boot side by side; herdr keeps the omo check.
# -Herdr, -Hc and -NoLaunch are test seams: a fake herdr or hc, and no omo check / Windows Terminal / agent start.
param([string]$Herdr = 'herdr', [string]$Hc = 'hc', [switch]$NoLaunch)
$ErrorActionPreference = 'Continue'
$doriHome = if ($env:DORI_HOME) { $env:DORI_HOME } else { Join-Path $env:USERPROFILE '.dori' }
$stateDir = Join-Path $doriHome 'state'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$log = Join-Path $stateDir 'boot.log'
function Log([string]$m) { "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m | Add-Content -Path $log -Encoding utf8 }

Log 'boot start'
$configPath = Join-Path $doriHome 'config.json'
$config = if (Test-Path -LiteralPath $configPath) { Get-Content -LiteralPath $configPath -Raw -Encoding utf8 | ConvertFrom-Json } else { [pscustomobject]@{} }
$name = if ($env:DORI_NAME) { $env:DORI_NAME } elseif ($config.name) { [string]$config.name } else { 'Dori' }
$label = if ($config.label) { [string]$config.label } else { $name }
$label = ($label.ToLowerInvariant() -replace '[^\w-]+', '-').Trim('-')
if (-not $label) { $label = 'dori' }
$bootCwd = if ($config.bootCwd) { ([string]$config.bootCwd) -replace '^~(?=$|[\\/])', $env:USERPROFILE } else { $env:USERPROFILE }
$agentCommand = if ($config.bootCommand) { @($config.bootCommand | ForEach-Object { [string]$_ }) } elseif ($config.agentCommand) { @($config.agentCommand | ForEach-Object { [string]$_ }) } else { @('omo', '--model', '{model}', '{prompt}') }

$runtime = if ($env:DORI_RUNTIME) { $env:DORI_RUNTIME } elseif ($config.runtime) { [string]$config.runtime } else { 'herdr' }
if ($runtime -ne 'hc' -and -not $NoLaunch -and (Get-Process -Name omo -ErrorAction SilentlyContinue)) { Log 'omo already running; nothing to do'; exit 0 }

# True when a process named like the agent program runs anywhere below the given pid (children made after their parent only:
# a reused pid must not pull an unrelated process in).
function Test-AgentBelow([int]$Root, [string]$Program) {
    if ($Root -le 0) { return $false }
    $want = [IO.Path]::GetFileNameWithoutExtension($Program).ToLowerInvariant()
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $byPid = @{}; foreach ($p in $all) { $byPid[[int]$p.ProcessId] = $p }
    if (-not $byPid.ContainsKey($Root)) { return $false }
    $queue = New-Object System.Collections.Generic.Queue[int]; $queue.Enqueue($Root)
    while ($queue.Count) {
        $parent = $byPid[$queue.Dequeue()]
        foreach ($c in $all) {
            if ([int]$c.ParentProcessId -ne [int]$parent.ProcessId -or [int]$c.ProcessId -eq $PID) { continue }
            if ($parent.CreationDate -and $c.CreationDate -and $c.CreationDate -lt $parent.CreationDate) { continue }
            if ([IO.Path]::GetFileNameWithoutExtension([string]$c.Name).ToLowerInvariant() -eq $want) { return $true }
            $queue.Enqueue([int]$c.ProcessId)
        }
    }
    $false
}

$reuse = $false
if ($runtime -eq 'hc') {
    # The core starts on the first call; the lead runs the user's shell (hc's default: PowerShell 7, else 5.1).
    & $Hc --json server status *> $null
    $listed = & $Hc --json ls --label "dori.group=$label" --label 'dori.role=lead' | Out-String
    $pane = ([regex]::Match($listed, '"address":"(t\d+)"')).Groups[1].Value
    if ($pane) {
        $got = & $Hc --json get $pane | Out-String
        $shellPid = try { [int]($got | ConvertFrom-Json).pid } catch { 0 }
        if (Test-AgentBelow $shellPid $agentCommand[0]) { Log "lead $pane already runs $($agentCommand[0]); nothing to do"; Write-Output "BOOT_RUNNING pane=$pane"; exit 0 }
        $reuse = $true
        Log "reusing lead terminal $pane (no agent below its shell)"
    }
    else {
        $created = & $Hc --json run --bg --no-parent --no-notify --keep --cwd $bootCwd --name $label --label "dori.group=$label" --label 'dori.role=lead' | Out-String
        if (-not ($created -match '"address":"(t\d+)"')) {
            # The name is taken by a live terminal or is not a valid hc name (non-ASCII): an unnamed terminal, still labelled.
            $created = & $Hc --json run --bg --no-parent --no-notify --keep --cwd $bootCwd --label "dori.group=$label" --label 'dori.role=lead' | Out-String
        }
        $pane = ([regex]::Match($created, '"address":"(t\d+)"')).Groups[1].Value
        if (-not $pane) { Log "hc run failed: $created"; exit 1 }
    }
    $workspace = $label
    # One Windows Terminal window ("dori") with a tab per Dori.
    if (-not $NoLaunch) { Start-Process wt.exe -ArgumentList '-w', 'dori', 'nt', '--title', $label, 'hc', 'attach', $pane; Log "hc attach $pane opened in Windows Terminal" }
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

    $created = & $Herdr workspace create --label $label --cwd $bootCwd --no-focus | Out-String
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

$cfgShown = if ($env:DORI_HOME) { $configPath } else { '~/.dori/config.json' }
$prompt = if ($config.bootPrompt) { [string]$config.bootPrompt } else { "$name mode. This session was started automatically after the PC rebooted. Start fresh, do not resume. " +
  'First read memory reference/dori/handoff.md, reference/dori/identity.md, reference/dori/operating-rules.md (skip any that do not exist). ' +
  "Then arm every persistent monitor in the handoff table; if there is no handoff note, arm the inbound monitor for $messenger, $inbound, and the monitors in the dori-mode skill setup. " +
  $(if ($runtime -eq 'hc') { "The boot script already wrote this PC's hc ids into $cfgShown (leadPane $pane, laneWorkspace $workspace, runtime hc); check them with hc get $pane. " } else { "The boot script already wrote this PC's herdr ids into $cfgShown (leadPane $pane, laneWorkspace $workspace); check them with herdr pane current. " }) +
  'Then ' + $post +
  'After that, wait for messages.' }
$argv = foreach ($part in $agentCommand) { "'" + $part.Replace('{model}', $model).Replace('{prompt}', $prompt).Replace("'", "''") + "'" }
$line = '& ' + ($argv -join ' ')
# A second Dori (DORI_HOME set): its session and everything it starts read this folder, not ~/.dori.
if ($env:DORI_HOME) {
    $q = { param($v) "'" + ([string]$v).Replace("'", "''") + "'" }
    $set = @("`$env:DORI_HOME=$(& $q $doriHome)", "`$env:DORI_CONFIG=$(& $q $configPath)", "`$env:DORI_STATE_DIR=$(& $q $stateDir)")
    if ($messenger -ne 'none' -and (Test-Path -LiteralPath (Join-Path $doriHome "$messenger.env"))) { $set += "`$env:DORI_ENV_FILE=$(& $q (Join-Path $doriHome "$messenger.env"))" }
    $line = ($set -join '; ') + '; ' + $line
}
if ($NoLaunch) { Log 'NoLaunch: agent not started'; Write-Output "BOOT_OK pane=$pane workspace=$workspace name=$name messenger=$messenger runtime=$runtime reuse=$reuse"; Write-Output "BOOT_LINE $line"; exit 0 }
Start-Sleep -Seconds $(if ($reuse) { 0 } else { 3 })
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
