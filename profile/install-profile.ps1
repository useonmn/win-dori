# Places the Windows Dori setup (profile/dori in this repo: the logon boot script) into %USERPROFILE%\.dori and registers
# the "<Name> Autostart" scheduled task for the current user (Name: DORI_NAME, else "name" in config.json, else "Dori").
# Safe to re-run; it asks nothing. The messenger tokens are user environment variables (DORI_SLACK_TOKEN and so on, as the
# dori-mode skill setup documents); the boot script picks the messenger from them.
# install.ps1 runs this after installing the dori CLI; it can also be run on its own:
#   powershell -NoProfile -ExecutionPolicy Bypass -File profile\install-profile.ps1 [-DryRun] [-Force] [-NoTask | -TaskOnly]
#
# A file is updated only when nobody edited it since the last install (hashes in ~/.dori/.profile-installed.json).
# A file with local edits is kept and its difference shown; -Force replaces it after saving <file>.bak-<time>.
param(
  [string]$Source = (Join-Path $PSScriptRoot 'dori'),
  [string]$DoriHome = (Join-Path $env:USERPROFILE '.dori'),
  [string]$TaskName = '',
  [switch]$DryRun,   # show what would change, change nothing
  [switch]$Force,    # replace locally edited files (a backup is kept)
  [switch]$NoTask,   # do not register the scheduled task
  [switch]$TaskOnly  # only register or update the task (re-register it by hand)
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell started from PowerShell 7 inherits its module path and then cannot load its own Get-FileHash.
if ($PSVersionTable.PSEdition -ne 'Core') {
  $env:PSModulePath = (@([Environment]::GetEnvironmentVariable('PSModulePath', 'User'), [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')) | Where-Object { $_ }) -join ';'
}
$Source = [IO.Path]::GetFullPath($Source)
$DoriHome = [IO.Path]::GetFullPath($DoriHome)
if (-not $TaskName) {
  $cfg = Join-Path $DoriHome 'config.json'
  $cfgName = if (Test-Path -LiteralPath $cfg) { (Get-Content -LiteralPath $cfg -Raw -Encoding utf8 | ConvertFrom-Json).name }
  $doriName = if ($env:DORI_NAME) { $env:DORI_NAME } elseif ($cfgName) { [string]$cfgName } else { 'Dori' }
  $TaskName = "$doriName Autostart"
}
$stateFile = Join-Path $DoriHome '.profile-installed.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$undo = New-Object System.Collections.Generic.List[string]
$verb = if ($DryRun) { 'would ' } else { '' }
function Say([string]$m) { Write-Host "  $m" }

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
}

# 2. Scheduled task --------------------------------------------------------------------------------------------
if (-not $NoTask) {
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

# 3. Undo ------------------------------------------------------------------------------------------------------
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
