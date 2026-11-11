# Installs the dori-mode skill and the `dori` CLI on Windows. One line, from any folder in PowerShell:
#   irm https://raw.githubusercontent.com/useonmn/win-dori/main/install.ps1 | iex
# Needs git, bun and a session runtime (hc or herdr), like install.sh it installs none of them: a missing one stops the
# install with its link. Set the runtime first, $env:DORI_RUNTIME='hc' (or 'herdr'), unless config.json says it already.
# Optional env: DORI_REPO (owner/name, clone URL or local path; a private owner/name needs `gh auth login`),
# DORI_SRC (checkout dir), SKILLS_DIR (where your agent loads skills),
# DORI_NO_PULL=1 (or true, yes: install an existing checkout as it is, without pulling),
# DORI_NO_USER_ENV=1 (leave the user PATH alone).
# It copies config.example.json to ~\.dori\config.json when that is missing, then places the Windows logon boot script
# and registers the autostart task (profile\install-profile.ps1). Profile env: DORI_DRY_RUN=1 (show changes only),
# DORI_FORCE=1 (replace edited files, with backups), DORI_SKIP_PROFILE=1 (CLI and skill only), DORI_NO_TASK=1,
# DORI_NAME (your Dori's name for the herdr workspace and the autostart task; default "name" in config.json, else Dori).
$ErrorActionPreference = 'Stop'

$repo = if ($env:DORI_REPO) { $env:DORI_REPO } else { 'useonmn/win-dori' }

$userHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { [Environment]::GetFolderPath('UserProfile') }
$noUserEnv = $env:DORI_NO_USER_ENV -eq '1'
$doriHome = Join-Path $userHome '.dori'
$skills = if ($env:SKILLS_DIR) { $env:SKILLS_DIR } else { Join-Path $userHome '.agents\skills' }
$src = if ($env:DORI_SRC) { $env:DORI_SRC } else { Join-Path $doriHome 'src' }
# install.ps1 run from inside a checkout installs that copy, wherever it is: no clone, no network, and any path
# (spaces and non-ASCII included) works because every path below is passed as one argument.
$fromCheckout = $false
if (-not $env:DORI_SRC -and $PSScriptRoot -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'skills\dori-mode') -PathType Container)) {
  $src = $PSScriptRoot
  $fromCheckout = $true
}

# Prerequisites are checked, never installed, as install.sh does.
function Test-Command([string]$Name) { [bool](Get-Command $Name -ErrorAction SilentlyContinue) }
$again = 'then open a new terminal and run install.ps1 again'
if (-not (Test-Command git)) { throw "git is required: https://git-scm.com/download/win (or: winget install Git.Git), $again" }
if (-not (Test-Command bun)) { throw "bun is required: https://bun.sh (PowerShell: irm bun.sh/install.ps1 | iex), $again" }
# The session runtime, as dori picks it: DORI_RUNTIME, else "runtime" in the Dori's config.json, else hc or herdr on PATH.
$doriConfig = Join-Path $doriHome 'config.json'
$runtime = if ($env:DORI_RUNTIME) { $env:DORI_RUNTIME } elseif (Test-Path -LiteralPath $doriConfig) {
  try { [string](Get-Content -LiteralPath $doriConfig -Raw -Encoding utf8 | ConvertFrom-Json).runtime } catch { '' }
} else { '' }
$runtimeLink = @{ hc = 'https://github.com/herdrdev/herdr-core'; herdr = 'https://herdr.dev' }
$pick = "Pick one: `$env:DORI_RUNTIME='hc' (herdr-core, $($runtimeLink.hc)) or `$env:DORI_RUNTIME='herdr' ($($runtimeLink.herdr)), install it, $again"
if ($runtime) {
  if ($runtime -cnotin @('hc', 'herdr')) { throw "The runtime must be hc or herdr, got '$runtime'. $pick" }
  if (-not (Test-Command $runtime)) { throw "${runtime} is required for runtime ${runtime}: $($runtimeLink[$runtime]), $again" }
}
elseif (Test-Command hc) { $runtime = 'hc' }
elseif (Test-Command herdr) { $runtime = 'herdr' }
else { throw "No session runtime: DORI_RUNTIME is not set and neither hc nor herdr is on PATH. $pick" }

function Invoke-Native([string]$What, [scriptblock]$Block) {
  & $Block
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)" }
}

# The checkout's own update, as install.sh does it: fetch, then fast-forward to the upstream branch. Only local work
# (edits, or commits upstream lacks) is ours to explain; anything else is git's message above.
function Write-Err([string]$Text) { [Console]::Error.WriteLine($Text) }
function Update-Checkout([string]$Dir, [string[]]$Auth) {
  # Windows PowerShell 5.1 turns native stderr into a terminating error under 'Stop'; git's messages are plain output here.
  $ErrorActionPreference = 'Continue'
  if ($env:DORI_NO_PULL -cmatch '^(1|true|yes)$') {
    Write-Err "DORI_NO_PULL=$($env:DORI_NO_PULL): installing $Dir as it is, without pulling"
    return
  }
  & git @Auth -C $Dir fetch --quiet
  if ($LASTEXITCODE -ne 0) {
    Write-Err "Could not fetch updates for $Dir; git's message above says why."
    throw "could not update $Dir"
  }
  & git -C $Dir merge --ff-only --quiet '@{u}'
  if ($LASTEXITCODE -eq 0) { return }
  & git -C $Dir rev-parse --verify --quiet '@{u}' *> $null
  $hasUpstream = $LASTEXITCODE -eq 0
  $local = ''
  if ($hasUpstream) {
    $local = (& git -C $Dir status --porcelain | Out-String) + (& git -C $Dir rev-list '@{u}..HEAD' | Out-String)
  }
  if ($hasUpstream -and $local.Trim()) {
    Write-Err "Could not update $Dir. Local work in that checkout:"
    Write-Err ((& git -C $Dir status --short --branch | Out-String).TrimEnd())
    Write-Err ((& git -C $Dir log --oneline '@{u}..HEAD' | Out-String).TrimEnd())
    Write-Err 'To keep it and install the checkout as it is, run install.ps1 again with DORI_NO_PULL=1.'
    Write-Err "To drop it and update: git -C `"$Dir`" reset --hard '@{u}', then run install.ps1 again."
  }
  else {
    Write-Err "Could not update $Dir; git's message above says why."
  }
  # throw, not exit: under irm | iex an exit would close the user's own PowerShell window.
  throw "could not update $Dir"
}

# A bare owner/name is a GitHub repo. A public one is cloned over plain https; gh's login is used when gh is
# installed and logged in, so a private fork works too.
$isSlug = $repo -match '^[\w.-]+/[\w.-]+$' -and -not (Test-Path -LiteralPath $repo)
$useGh = $false
if (Get-Command gh -ErrorAction SilentlyContinue) {
  & cmd /c 'gh auth status >nul 2>nul'
  $useGh = $LASTEXITCODE -eq 0
}
$ghAuth = if ($useGh) { @('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential') } else { @() }
if ($isSlug -and -not $useGh) { $repo = "https://github.com/$repo.git"; $isSlug = $false }

if ($fromCheckout) {
  Write-Host "Using this checkout $src"
}
elseif (Test-Path -LiteralPath (Join-Path $src '.git')) {
  Update-Checkout $src $ghAuth
}
elseif (Test-Path -LiteralPath (Join-Path $src 'skills\dori-mode') -PathType Container) {
  Write-Host "Using existing copy $src"
}
elseif ($isSlug) {
  Invoke-Native 'gh repo clone' { gh repo clone $repo $src -- --quiet --depth 1 }
}
else {
  Invoke-Native 'git clone' { git @ghAuth clone --quiet --depth 1 $repo $src }
}

$skillSrc = Join-Path $src 'skills\dori-mode'
$link = Join-Path $skills 'dori-mode'
New-Item -ItemType Directory -Force -Path $skills | Out-Null
$existing = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
if ($existing -and -not ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  Write-Warning "$link exists and is not a link; leaving it alone"
}
else {
  if ($existing) { [IO.Directory]::Delete($link) }
  New-Item -ItemType Junction -Path $link -Target $skillSrc | Out-Null
}

Push-Location (Join-Path $skillSrc 'scripts')
try {
  Invoke-Native 'bun install' { bun install --silent }
  Invoke-Native 'bun link' { bun link --silent }
  # On a new bun, `bun pm bin -g` fails until the global folder has a package.json; bun's own bin folder is the answer then.
  $binOut = & cmd /c 'bun pm bin -g 2>nul'
  $binDir = if ($LASTEXITCODE -eq 0 -and $binOut) { @($binOut)[0] }
    else { Join-Path $(if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $userHome '.bun' }) 'bin' }
}
finally { Pop-Location }

function Get-PathKey([string]$Path) {
  try { [IO.Path]::GetFullPath($Path).TrimEnd('\') } catch { $Path.TrimEnd('\') }
}
$binDir = Get-PathKey $binDir
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$onPath = @($userPath -split ';' | Where-Object { $_ }) | Where-Object { (Get-PathKey $_) -ieq $binDir }
if (-not $onPath -and -not $noUserEnv) {
  $newPath = if ($userPath) { $userPath.TrimEnd(';') + ';' + $binDir } else { $binDir }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Host "Added $binDir to your user PATH; open a new terminal to pick it up"
}
if (-not (($env:Path -split ';') | Where-Object { $_ -and (Get-PathKey $_) -ieq $binDir })) {
  $env:Path = "$env:Path;$binDir"
}
if (-not (Get-Command dori -ErrorAction SilentlyContinue)) { Write-Warning "dori is not resolvable yet; check $binDir" }

New-Item -ItemType Directory -Force -Path $doriHome | Out-Null
$config = Join-Path $doriHome 'config.json'
if (-not (Test-Path -LiteralPath $config)) {
  Copy-Item -LiteralPath (Join-Path $skillSrc 'references\config.example.json') -Destination $config
}
try { $configRuntime = [string](Get-Content -LiteralPath $config -Raw -Encoding utf8 | ConvertFrom-Json).runtime } catch { $configRuntime = '' }
if ($configRuntime -and $configRuntime -cne $runtime) {
  Write-Warning "$config says `"runtime`": `"$configRuntime`" but this install checked $runtime; set `"runtime`": `"$runtime`" there"
}
$profileScript = Join-Path $src 'profile\install-profile.ps1'
if ($env:DORI_SKIP_PROFILE -ne '1' -and (Test-Path -LiteralPath $profileScript)) {
  $flags = @('-DoriHome', $doriHome)
  if ($env:DORI_DRY_RUN -eq '1') { $flags += '-DryRun' }
  if ($env:DORI_FORCE -eq '1') { $flags += '-Force' }
  if ($env:DORI_NO_TASK -eq '1') { $flags += '-NoTask' }
  $ps = (Get-Process -Id $PID).Path
  Invoke-Native 'profile\install-profile.ps1' { & $ps -NoProfile -ExecutionPolicy Bypass -File $profileScript @flags }
}

Write-Host "Installed. Source: $src  Skill: $link  CLI: dori  Config: $config"
Write-Host "Next: edit $config, then tell your agent: Dori mode"
