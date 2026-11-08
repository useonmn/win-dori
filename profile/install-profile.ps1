# Places the Windows Dori setup (profile/dori in this repo) into %USERPROFILE%\.dori and, once one messenger's env file
# (slack.env, telegram.env or discord.env) is complete, registers the "<Name> Autostart" scheduled task for the current
# user (Name: DORI_NAME, else "name" in config.json, else "Dori"). Safe to re-run. It asks nothing by default:
# the Dori asks which messenger and its tokens in conversation ("Dori mode" -> dori setup <messenger>), and
# dori setup runs this script with -TaskOnly (hooks.autostart in config.json) once that env file is complete.
# -AskSecrets prompts here instead, for -Messenger (DORI_MESSENGER), or asks which messenger.
# install.ps1 runs this after installing the dori CLI; it can also be run on its own:
#   powershell -NoProfile -ExecutionPolicy Bypass -File profile\install-profile.ps1 [-DryRun] [-Force] [-AskSecrets [-Messenger telegram]]
#
# A file is updated only when nobody edited it since the last install (hashes in ~/.dori/.profile-installed.json).
# A file with local edits is kept and its difference shown; -Force replaces it after saving <file>.bak-<time>.
# config.json is only created, never replaced: the boot script writes this PC's herdr ids into it.
param(
  [string]$Source = (Join-Path $PSScriptRoot 'dori'),
  [string]$DoriHome = $(if ($env:DORI_HOME) { $env:DORI_HOME } else { Join-Path $env:USERPROFILE '.dori' }),
  [string]$TaskName = '',
  [switch]$DryRun,     # show what would change, change nothing
  [switch]$Force,      # replace locally edited files (a backup is kept)
  [switch]$NoTask,     # do not register the scheduled task
  [switch]$NoPrompt,   # never ask, even with -AskSecrets (the default is already not to ask)
  [switch]$AskSecrets, # prompt in this terminal for the missing values of one messenger (DORI_ASK_SECRETS=1 in install.ps1)
  [string]$Messenger = $env:DORI_MESSENGER, # slack, telegram or discord: which one -AskSecrets prompts for (asked when empty)
  [switch]$TaskOnly,   # only register or update the task, and only when a messenger env file is complete (run by dori setup)
  [switch]$SecretsFromEnv # take missing values from DORI_SLACK_* / DORI_TELEGRAM_* / DORI_DISCORD_* environment variables
                          # (automation, tests); off by default, because a process can inherit stale values from whatever launched it
)
# Secrets live only in ~/.dori/<messenger>.env (owner-only ACL). Nothing here writes them to user environment variables:
# every process would inherit them, and a stale inherited token once broke the listener. dori and the listener read the files.
$ErrorActionPreference = 'Stop'
# Windows PowerShell started from PowerShell 7 inherits its module path and then cannot load its own Get-FileHash or Get-Acl.
if ($PSVersionTable.PSEdition -ne 'Core') {
  $env:PSModulePath = (@([Environment]::GetEnvironmentVariable('PSModulePath', 'User'), [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')) | Where-Object { $_ }) -join ';'
}
$Source = [IO.Path]::GetFullPath($Source)
$DoriHome = [IO.Path]::GetFullPath($DoriHome)
if (-not $TaskName) {
  $cfg = @((Join-Path $DoriHome 'config.json'), (Join-Path $Source 'config.json')) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  $cfgName = if ($cfg) { (Get-Content -LiteralPath $cfg -Raw -Encoding utf8 | ConvertFrom-Json).name }
  $doriName = if ($env:DORI_NAME) { $env:DORI_NAME } elseif ($cfgName) { [string]$cfgName } else { 'Dori' }
  $TaskName = "$doriName Autostart"
}
$createOnly = @('config.json')
$stateFile = Join-Path $DoriHome '.profile-installed.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$undo = New-Object System.Collections.Generic.List[string]
$verb = if ($DryRun) { 'would ' } else { '' }
function Say([string]$m) { Write-Host "  $m" }

$ask = $AskSecrets -and -not $NoPrompt
$messengers = @('slack', 'telegram', 'discord')
if ($Messenger -and $messengers -notcontains $Messenger) { throw "-Messenger must be one of: $($messengers -join ', ') (got '$Messenger')" }
function Get-EnvPath([string]$M) { Join-Path $DoriHome "$M.env" }
# The keys each messenger needs, as in dori setup (skills/dori-mode/scripts/src/setup.ts, requiredKeys). A Slack user
# token (xoxp-, or xoxc- with its cookie) needs no app token or app id.
function Get-MessengerMissing([string]$M, [System.Collections.IDictionary]$Values) {
  $need = switch ($M) {
    'telegram' { 'DORI_TELEGRAM_TOKEN', 'DORI_TELEGRAM_BOT', 'DORI_TELEGRAM_OWNER' }
    'discord' { 'DORI_DISCORD_TOKEN', 'DORI_DISCORD_APP_ID', 'DORI_DISCORD_BOT_USER', 'DORI_DISCORD_OWNER' }
    default {
      $token = [string]$Values['DORI_SLACK_TOKEN']
      if ($token -like 'xoxc-*') { 'DORI_SLACK_TOKEN', 'DORI_SLACK_COOKIE', 'DORI_SLACK_CHANNEL', 'DORI_SLACK_OWNER', 'DORI_SLACK_BOT_USER' }
      elseif ($token -like 'xoxp-*') { 'DORI_SLACK_TOKEN', 'DORI_SLACK_CHANNEL', 'DORI_SLACK_OWNER', 'DORI_SLACK_BOT_USER' }
      else { 'DORI_SLACK_TOKEN', 'DORI_SLACK_APP_TOKEN', 'DORI_SLACK_APP_ID', 'DORI_SLACK_CHANNEL', 'DORI_SLACK_OWNER', 'DORI_SLACK_BOT_USER' }
    }
  }
  @($need | Where-Object { -not $Values[$_] })
}
function Read-MessengerEnv([string]$M) {
  $v = [ordered]@{}
  $path = Get-EnvPath $M
  if (Test-Path -LiteralPath $path) {
    foreach ($l in Get-Content -LiteralPath $path -Encoding utf8) { $i = $l.IndexOf('='); if ($i -gt 0) { $v[$l.Substring(0, $i).Trim()] = $l.Substring($i + 1).Trim() } }
  }
  $v
}
$envValues = @{}

if (-not $TaskOnly) {
# 1. Files ----------------------------------------------------------------------------------------------------
Write-Host "Dori profile: $Source -> $DoriHome$(if ($DryRun) { ' (dry run)' })"
$state = @{}
if (Test-Path -LiteralPath $stateFile) {
  (Get-Content -LiteralPath $stateFile -Raw -Encoding utf8 | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $state[$_.Name] = $_.Value }
}
$hash = { param($p) (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash }
$counts = @{ added = 0; updated = 0; same = 0; kept = 0; replaced = 0 }
foreach ($file in Get-ChildItem -LiteralPath $Source -Recurse -File) {
  $rel = $file.FullName.Substring($Source.Length).TrimStart('\', '/')
  $key = $rel -replace '\\', '/'
  $dst = Join-Path $DoriHome $rel
  $srcHash = & $hash $file.FullName
  if (-not (Test-Path -LiteralPath $dst)) {
    Say "${verb}add      $key"
    if (-not $DryRun) {
      New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
      Copy-Item -LiteralPath $file.FullName -Destination $dst
      $state[$key] = $srcHash
      $undo.Add("Remove-Item '$dst'")
    }
    $counts.added++
    continue
  }
  $dstHash = & $hash $dst
  if ($dstHash -eq $srcHash) { $state[$key] = $srcHash; $counts.same++; continue }
  $untouched = $state.ContainsKey($key) -and $state[$key] -eq $dstHash
  if ($createOnly -contains $key) { Say "keep     $key (created once, edited on this PC)"; $counts.kept++; continue }
  if ($untouched -or $Force) {
    $tag = if ($untouched) { 'update  ' } else { 'replace ' }
    Say "${verb}$tag $key$(if (-not $untouched) { " (local edits saved to $key.bak-$stamp)" })"
    if (-not $DryRun) {
      if (-not $untouched) { Copy-Item -LiteralPath $dst -Destination "$dst.bak-$stamp"; $undo.Add("Move-Item -Force '$dst.bak-$stamp' '$dst'") }
      Copy-Item -LiteralPath $file.FullName -Destination $dst -Force
      $state[$key] = $srcHash
    }
    if ($untouched) { $counts.updated++ } else { $counts.replaced++ }
    continue
  }
  Say "keep     $key (local edits; re-run with -Force to replace, a backup is kept)"
  $diff = Compare-Object (Get-Content -LiteralPath $dst -Encoding utf8) (Get-Content -LiteralPath $file.FullName -Encoding utf8)
  foreach ($d in @($diff) | Select-Object -First 12) {
    $side = if ($d.SideIndicator -eq '<=') { 'local' } else { 'repo ' }
    $text = [string]$d.InputObject
    if ($text.Length -gt 160) { $text = $text.Substring(0, 160) + '...' }
    Say "    $side | $text"
  }
  if (@($diff).Count -gt 12) { Say "    ... $(@($diff).Count - 12) more differing lines" }
  $counts.kept++
}
if (-not $DryRun) {
  New-Item -ItemType Directory -Force -Path $DoriHome | Out-Null
  $ordered = [ordered]@{}
  foreach ($k in ($state.Keys | Sort-Object)) { $ordered[$k] = $state[$k] }
  [IO.File]::WriteAllText($stateFile, (($ordered | ConvertTo-Json) + "`n"), (New-Object Text.UTF8Encoding $false))
}
Say ("files: {0} added, {1} updated, {2} replaced, {3} unchanged, {4} kept" -f $counts.added, $counts.updated, $counts.replaced, $counts.same, $counts.kept)

# 2. Secrets ---------------------------------------------------------------------------------------------------
# icacls, as dori setup does: Set-Acl rewrites the whole security descriptor and fails without SeSecurityPrivilege
# on a file that is already owner-only, which broke every re-run.
function Protect-OwnerOnly([string]$Path) {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  # /reset first: explicit entries from the token's default DACL survive /inheritance:r.
  $out = & icacls $Path /reset 2>&1
  if ($LASTEXITCODE -ne 0) { throw "icacls /reset failed on ${Path} (exit $LASTEXITCODE): $out" }
  $out = & icacls $Path /inheritance:r /grant:r "*${sid}:(F)" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "icacls failed on ${Path} (exit $LASTEXITCODE): $out" }
}
function Read-Value([string]$Prompt, [bool]$Secret) {
  if ($Secret) {
    $s = Read-Host -AsSecureString $Prompt
    return (New-Object System.Net.NetworkCredential('', $s)).Password
  }
  return (Read-Host $Prompt)
}
$prompts = @{
  slack = @(
    @{ Key = 'DORI_SLACK_TOKEN'; Secret = $true; Prompt = 'Slack bot token (xoxb-...)' },
    @{ Key = 'DORI_SLACK_APP_TOKEN'; Secret = $true; Prompt = 'Slack app-level token for Socket Mode (xapp-...)' },
    @{ Key = 'DORI_SLACK_APP_ID'; Secret = $false; Prompt = 'Slack app id (A...)' },
    @{ Key = 'DORI_SLACK_CHANNEL'; Secret = $false; Prompt = 'Dori home channel id (C...)' },
    @{ Key = 'DORI_SLACK_OWNER'; Secret = $false; Prompt = 'Your Slack member id (U...)' },
    @{ Key = 'DORI_SLACK_BOT_USER'; Secret = $false; Prompt = 'The bot user id (U...)' }
  )
  telegram = @(
    @{ Key = 'DORI_TELEGRAM_TOKEN'; Secret = $true; Prompt = 'Telegram bot token (from @BotFather)' },
    @{ Key = 'DORI_TELEGRAM_BOT'; Secret = $false; Prompt = 'The bot username, without @' },
    @{ Key = 'DORI_TELEGRAM_OWNER'; Secret = $false; Prompt = 'Your Telegram user id (a number)' }
  )
  discord = @(
    @{ Key = 'DORI_DISCORD_TOKEN'; Secret = $true; Prompt = 'Discord bot token' },
    @{ Key = 'DORI_DISCORD_APP_ID'; Secret = $false; Prompt = 'Discord application id' },
    @{ Key = 'DORI_DISCORD_BOT_USER'; Secret = $false; Prompt = 'The bot user id' },
    @{ Key = 'DORI_DISCORD_OWNER'; Secret = $false; Prompt = 'Your Discord user id' }
  )
}
$askFor = ''
if ($ask -and -not $DryRun) {
  $askFor = $Messenger
  while ($messengers -notcontains $askFor) { $askFor = (Read-Host "Messenger ($($messengers -join ', '))").Trim().ToLowerInvariant() }
}
foreach ($m in $messengers) {
  $envPath = Get-EnvPath $m
  $values = Read-MessengerEnv $m
  $changed = $false
  foreach ($s in $prompts[$m]) {
    if ($values[$s.Key]) { continue }
    $v = if ($SecretsFromEnv) { [Environment]::GetEnvironmentVariable($s.Key) } else { $null }
    if (-not $v -and $m -eq $askFor) { $v = Read-Value $s.Prompt $s.Secret }
    if ($v) { $values[$s.Key] = $v.Trim(); $changed = $true; Say "${verb}set      $m.env $($s.Key)" }
  }
  if ($changed -and -not $DryRun) {
    $existed = Test-Path -LiteralPath $envPath
    $lines = foreach ($k in $values.Keys) { "$k=$($values[$k])" }
    [IO.File]::WriteAllText($envPath, (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))
    if (-not $existed) { $undo.Add("Remove-Item '$envPath'") }
  }
  if ((Test-Path -LiteralPath $envPath) -and -not $DryRun) { Protect-OwnerOnly $envPath; Say "secured  $m.env (only you can read it)" }
  $envValues[$m] = $values
}
}


# 3. Scheduled task --------------------------------------------------------------------------------------------
# Registered only once one messenger's env file is complete: the boot script starts a Dori that would otherwise have
# no way to hear its owner, and its listener would exit on the missing tokens at every logon.
$ready = @()
$partial = @()
foreach ($m in $messengers) {
  $values = if ($TaskOnly -or -not $envValues.ContainsKey($m)) { Read-MessengerEnv $m } else { $envValues[$m] }
  if (-not $values.Count) { continue }
  $gaps = @(Get-MessengerMissing $m $values)
  if ($gaps.Count) { $partial += "$m.env is missing $($gaps -join ', ')" } else { $ready += $m }
}
if (-not $TaskOnly -and -not $ready.Count) {
  Say "missing  no messenger is set up yet (slack.env, telegram.env or discord.env): open omo in herdr and say 'Dori mode'; the Dori asks which messenger and its tokens (dori setup <messenger>). Or re-run with -AskSecrets."
}
if (-not $NoTask -and -not $ready.Count) {
  $why = if ($partial.Count) { $partial -join '; ' } else { 'no slack.env, telegram.env or discord.env yet' }
  Say "task     '$TaskName' not registered yet: $why; dori setup <messenger> registers it once the tokens are saved"
  if ($TaskOnly) { Write-Host 'Nothing changed.'; exit 2 }
}
elseif (-not $NoTask) {
  $boot = Join-Path $DoriHome 'boot\dori-boot.ps1'
  $shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
  $taskArgs = "--headless cmd.exe /c $shell -NoProfile -ExecutionPolicy Bypass -File `"$boot`""
  # The logged-on account as Windows names it; USERDOMAIN can read WORKGROUP, which maps to no account.
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $current = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $same = $current -and $current.Actions.Count -eq 1 -and $current.Actions[0].Execute -eq 'conhost.exe' -and $current.Actions[0].Arguments -eq $taskArgs
  if ($same) { Say "task     '$TaskName' unchanged" }
  else {
    Say "${verb}$(if ($current) { 'update' } else { 'register' }) task '$TaskName' (at logon of $user, 30 s delay): $boot"
    if (-not $DryRun) {
      $action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument $taskArgs
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
      $trigger.Delay = 'PT30S'
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
      $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
      Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
      if (-not $current) { $undo.Add("Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false") }
    }
  }
}

# 4. Undo ------------------------------------------------------------------------------------------------------
if ($DryRun) { Write-Host 'Dry run: nothing was changed.'; return }
Write-Host 'Dori profile installed.'
if ($undo.Count) {
  $undoFile = Join-Path $DoriHome "undo-profile-$stamp.ps1"
  $steps = $undo.ToArray()
  [array]::Reverse($steps)
  [IO.File]::WriteAllText($undoFile, ($steps -join "`n") + "`n", (New-Object Text.UTF8Encoding $false))
  Write-Host "To undo this run: powershell -NoProfile -ExecutionPolicy Bypass -File `"$undoFile`""
}
else { Write-Host 'Nothing changed, nothing to undo.' }
