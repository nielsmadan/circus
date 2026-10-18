manifest := "src-tauri/Cargo.toml"

[private]
default:
    @just --list

# Prepare this checkout for work: dependencies, hooks, then verify.
setup:
    @pnpm run setup

# Verify the tools and checkout state this repo needs.
doctor:
    #!/usr/bin/env bash
    set -uo pipefail
    fail=0
    need() {
        if command -v "$1" >/dev/null 2>&1; then
            printf '  ok       %s\n' "$1"
        else
            printf '  MISSING  %-12s install: %s\n' "$1" "$2"; fail=1
        fi
    }
    warn() {
        if command -v "$1" >/dev/null 2>&1; then
            printf '  ok       %s\n' "$1"
        else
            printf '  warn     %-12s install: %s\n' "$1" "$2"
        fi
    }
    need node "mise use node@24"
    need pnpm "mise use pnpm"
    need cargo "https://rustup.rs"
    need rustup "https://rustup.rs"
    need lefthook "brew install lefthook"
    need just "brew install just"
    if command -v node >/dev/null 2>&1; then
        major="$(node -p 'process.versions.node.split(".")[0]')"
        if [ "$major" -ge 24 ]; then
            printf '  ok       node >= 24\n'
        else
            printf '  MISSING  %-12s node %s found\n' 'node >= 24' "$major"; fail=1
        fi
    fi
    if command -v rustup >/dev/null 2>&1; then
        components="$(rustup component list --installed 2>/dev/null)"
        for c in clippy rustfmt; do
            if printf '%s\n' "$components" | grep -q "^$c"; then
                printf '  ok       rustup %s\n' "$c"
            else
                printf '  MISSING  %-12s run: rustup component add %s\n' "rustup $c" "$c"; fail=1
            fi
        done
    fi
    core=../shortcutkit-js/packages/core/src
    if [ -f "$core/index.ts" ]; then
        printf '  ok       %s\n' "$core/index.ts"
    else
        printf '  MISSING  %-12s expected beside this checkout\n' "$core/index.ts"; fail=1
    fi
    if [ -f "$(git rev-parse --git-path hooks/pre-commit)" ]; then
        printf '  ok       git hooks\n'
    else
        printf '  MISSING  %-12s run: just setup\n' 'git hooks'; fail=1
    fi
    warn uv "https://docs.astral.sh/uv/getting-started/installation/"
    if [ -d ../circus-worktrees/ringleader ]; then
        printf '  ok       ../circus-worktrees/ringleader\n'
    else
        printf '  warn     %-12s needed for the sandbox recipes\n' '../circus-worktrees/ringleader'
    fi
    if [ -d "$core" ]; then
        hash="$(find "$core" -name '*.ts' | LC_ALL=C sort | xargs shasum | shasum | cut -c1-12)"
        printf 'core src hash: %s\n' "$hash"
    fi
    [ "$fail" -eq 0 ] && printf 'Everything in place.\n'
    exit $fail

[private]
ensure-dist:
    @test -d dist || pnpm run build

format:
    @pnpm run format
    @cargo fmt --manifest-path {{manifest}}

lint: ensure-dist
    @pnpm run lint
    @cargo clippy --locked --manifest-path {{manifest}} --all-targets -- -D warnings

typecheck:
    @pnpm run type-check

test: ensure-dist
    @pnpm test
    @cargo test --locked --manifest-path {{manifest}}

build:
    @pnpm run build

# Everything CI runs.
check:
    @pnpm run check-all
    @pnpm test
    @pnpm run build
    @cargo fmt --manifest-path {{manifest}} --check
    @cargo clippy --locked --manifest-path {{manifest}} --all-targets -- -D warnings
    @cargo test --locked --manifest-path {{manifest}}

build-debug: ensure-dist
    @pnpm tauri build --debug --bundles app
