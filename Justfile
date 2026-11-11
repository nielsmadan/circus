manifest := "src-tauri/Cargo.toml"
golden_names := "contract-list.json contract-tails.json contract-outcome-ok.json contract-outcome-refused.json contract-handoff.json"

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
    for package in core dom react; do
        entry="node_modules/@shortcutkit/$package/src/index.ts"
        if [ -f "$entry" ]; then
            printf '  ok       %s\n' "$entry"
        else
            printf '  MISSING  %s; run: just setup\n' "$entry"; fail=1
        fi
    done
    if [ -f "$(git rev-parse --git-path hooks/pre-commit)" ]; then
        printf '  ok       git hooks\n'
    else
        printf '  MISSING  %-12s run: just setup\n' 'git hooks'; fail=1
    fi
    warn uv "https://docs.astral.sh/uv/getting-started/installation/"
    warn jq "https://jqlang.org/download/"
    warn gh "https://cli.github.com"
    printf '  ok       ringleader %s pinned in ringleader.json\n' "$(jq -r .latest ringleader.json 2>/dev/null || echo '?')"
    if {{just_executable()}} --justfile {{justfile()}} golden-check >/dev/null 2>&1; then
        printf '  ok       golden documents\n'
    else
        printf '  warn     %-12s stale or missing; run: just sync-golden\n' 'golden documents'
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

test: ensure-dist test-scripts
    @pnpm test
    @cargo test --locked --manifest-path {{manifest}}

# Test scripts/sandbox-env.sh against a stubbed uv.
test-scripts:
    @bash scripts/sandbox-env-test.sh

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
    @bash scripts/sandbox-env-test.sh

# Run the app against your live sessions through the installed rl.
run: ensure-dist
    @pnpm tauri dev

# Run the app against a freshly built synthetic world (never live data).
sandbox: ensure-dist
    #!/usr/bin/env bash
    set -euo pipefail
    source scripts/sandbox-env.sh
    pnpm tauri dev

# Stage the pinned ringleader release (or $CIRCUS_RINGLEADER_DIR) and print its directory.
[private]
ringleader-dir:
    @if [ -n "${CIRCUS_RINGLEADER_DIR:-}" ]; then printf '%s\n' "$CIRCUS_RINGLEADER_DIR"; else scripts/fetch-ringleader.sh; fi

# Pin a ringleader release: version and wheel sha256 from its SHA256SUMS.
pin-ringleader version:
    #!/usr/bin/env bash
    set -euo pipefail
    repository="$(jq -r .repository ringleader.json)"
    wheel="ringleader-{{version}}-py3-none-any.whl"
    sums="$(gh release download "v{{version}}" --repo "$repository" --pattern SHA256SUMS --output -)"
    sha="$(printf '%s\n' "$sums" | awk -v w="$wheel" '$2 == w || $2 == "*" w { print $1 }')"
    [ "${#sha}" -eq 64 ] || { echo "no sha256 for $wheel in v{{version}}'s SHA256SUMS" >&2; exit 1; }
    jq --arg v "{{version}}" --arg w "$wheel" --arg s "$sha" '.latest = $v | .wheel = $w | .sha256 = $s' ringleader.json > ringleader.json.tmp
    mv ringleader.json.tmp ringleader.json
    printf 'pinned ringleader %s (%s)\n' "{{version}}" "$sha"

# Build release-shaped ringleader assets from a checkout, for contract work before a release.
stage-ringleader checkout:
    @scripts/stage-ringleader.sh "{{checkout}}"

# Copy the pinned release's golden contract documents into src/test/golden.
sync-golden:
    #!/usr/bin/env bash
    set -euo pipefail
    dir="$({{just_executable()}} --justfile {{justfile()}} ringleader-dir)"
    mkdir -p src/test/golden
    tar -xzf "$dir/contract-golden.tar.gz" -C src/test/golden
    printf 'copied the golden documents from %s\n' "$dir"

# Fail when src/test/golden differs from the pinned release's golden documents.
golden-check:
    #!/usr/bin/env bash
    set -uo pipefail
    dir="$({{just_executable()}} --justfile {{justfile()}} ringleader-dir)" || exit 1
    source_dir="$(mktemp -d)"
    trap 'rm -rf "$source_dir"' EXIT
    tar -xzf "$dir/contract-golden.tar.gz" -C "$source_dir" || exit 1
    names=({{golden_names}})
    for file in "$source_dir"/contract-*.json; do
        names+=("$(basename "$file")")
    done
    for name in $(printf '%s\n' "${names[@]}" | sort -u); do
        if ! cmp -s "$source_dir/$name" "src/test/golden/$name"; then
            echo "golden documents are stale — run just sync-golden ($name)" >&2
            exit 1
        fi
    done
    echo "golden documents are current"

# Run the Rust client against a real `rl` in a freshly built synthetic world.
test-smoke: golden-check ensure-dist
    #!/usr/bin/env bash
    set -euo pipefail
    source scripts/sandbox-env.sh
    cargo test --locked --manifest-path {{manifest}} --test contract_smoke -- --ignored --test-threads=1

build-debug: ensure-dist
    @pnpm tauri build --debug --bundles app
