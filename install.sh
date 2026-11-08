#!/usr/bin/env bash
# Installs the dori-mode skill and the `dori` CLI on macOS and Linux.
# Usage: curl -fsSL https://raw.githubusercontent.com/useonmn/win-dori/main/install.sh | bash
# Needs git. Installs bun and herdr with their official installers when they are missing (DORI_NO_DEPS=1 skips that).
# Optional env: DORI_REPO (clone URL or local path), DORI_SRC (clone dir), SKILLS_DIR (where your agent loads skills),
# DORI_HOME (config dir, default ~/.dori).
# DORI_NO_PULL=1 (or true, yes: install an existing checkout as it is, without pulling).
set -euo pipefail

repo="${DORI_REPO:-https://github.com/useonmn/win-dori.git}"
dori_home="${DORI_HOME:-$HOME/.dori}"
src="${DORI_SRC:-$dori_home/src}"
skills="${SKILLS_DIR:-$HOME/.agents/skills}"

# Running install.sh from inside a checkout installs that copy, wherever it is and without a network: a path with
# spaces or non-ASCII characters is fine because everything below is quoted. Piped from curl, there is no checkout.
from_checkout=""
self="${BASH_SOURCE[0]:-}"
if [ -n "${DORI_SRC:-}" ]; then :; elif [ -n "$self" ] && [ -f "$self" ]; then
  here="$(cd "$(dirname "$self")" && pwd)"
  if [ -f "$here/package.json" ] && [ -d "$here/skills/dori-mode" ]; then src="$here"; from_checkout=1; fi
fi

command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
if ! command -v bun >/dev/null; then
  if [ "${DORI_NO_DEPS:-}" != "1" ]; then
    echo "Installing bun (https://bun.sh/install)"
    curl -fsSL https://bun.sh/install | bash
    export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
  fi
  command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }
fi
if ! command -v herdr >/dev/null && [ "${DORI_NO_DEPS:-}" != "1" ]; then
  echo "Installing herdr (https://herdr.dev/install.sh)"
  curl -fsSL https://herdr.dev/install.sh | sh || echo "herdr install failed; install it from https://herdr.dev" >&2
fi

if [ -n "$from_checkout" ]; then
  echo "Using this checkout: $src"
elif [ ! -d "$src/.git" ]; then
  if [ -d "$src/skills/dori-mode" ]; then echo "Using existing copy $src"
  else git clone --quiet --depth 1 "$repo" "$src"; fi
elif [[ "${DORI_NO_PULL:-}" =~ ^(1|true|yes)$ ]]; then
  echo "DORI_NO_PULL=$DORI_NO_PULL: installing $src as it is, without pulling" >&2
elif ! git -C "$src" fetch --quiet; then
  echo "Could not fetch updates for $src; git's message above says why." >&2
  exit 1
elif ! git -C "$src" merge --ff-only --quiet '@{u}'; then
  # Only local work (edits, or commits upstream lacks) is ours to explain; anything else is git's message above.
  if git -C "$src" rev-parse --verify --quiet '@{u}' >/dev/null &&
    [ -n "$(git -C "$src" status --porcelain)$(git -C "$src" rev-list '@{u}..HEAD')" ]; then
    echo "Could not update $src. Local work in that checkout:" >&2
    git -C "$src" status --short --branch >&2
    git -C "$src" log --oneline '@{u}..HEAD' >&2
    echo "To keep it and install the checkout as it is, run install.sh again with DORI_NO_PULL=1." >&2
    echo "To drop it and update: git -C \"$src\" reset --hard '@{u}', then run install.sh again." >&2
  else
    echo "Could not update $src; git's message above says why." >&2
  fi
  exit 1
fi

mkdir -p "$skills"
if [ -e "$skills/dori-mode" ] && [ ! -L "$skills/dori-mode" ]; then
  echo "$skills/dori-mode exists and is not a link; leaving it alone" >&2
else
  ln -sfn "$src/skills/dori-mode" "$skills/dori-mode"
fi

(cd "$src/skills/dori-mode/scripts" && bun install --silent && bun link --silent)
# The harness at the repo root: its own devDependencies, and the dori-harness command.
(cd "$src" && bun install --silent && bun link --silent) || echo "harness setup skipped" >&2

mkdir -p "$dori_home"
[ -f "$dori_home/config.json" ] || cp "$src/skills/dori-mode/references/config.example.json" "$dori_home/config.json"

bun_bin="${BUN_INSTALL:-$HOME/.bun}/bin"
case ":$PATH:" in
  *":$bun_bin:"*) ;;
  *) echo "Add bun's bin folder to your PATH so \`dori\` and \`dori-harness\` resolve:" >&2
     echo "  export PATH=\"$bun_bin:\$PATH\"" >&2 ;;
esac

echo "Installed. Source: $src  Skill: $skills/dori-mode  CLI: dori  Config: $dori_home/config.json"
echo "Next: open your agent inside herdr and say: Dori mode"
