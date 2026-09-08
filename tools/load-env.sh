#!/usr/bin/env bash
# Shared Polaris common-tool environment loader.
#
# Tool entrypoints source this file instead of reading an application-local
# environment file. The only supported configuration namespace is
# POLARIS_LITERATURE_*. A workflow may add its own identity after sourcing it.
set -euo pipefail

TOOLS_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${POLARIS_LITERATURE_ENV_FILE:-}"

# Shell-provided values win over the explicitly selected private env file.
declare -A _POLARIS_LITERATURE_SAVED _POLARIS_LITERATURE_PRESENT
for _key in POLARIS_LITERATURE_WORKSPACES_ROOT POLARIS_LITERATURE_CACHE_ROOT \
  POLARIS_LITERATURE_PDF_CACHE POLARIS_LITERATURE_RUNTIME_MODE \
  POLARIS_LITERATURE_CODEX_BIN POLARIS_LITERATURE_CODEX_CLI \
  POLARIS_LITERATURE_CODEX_MODEL POLARIS_LITERATURE_ANALYSIS_MODEL \
  POLARIS_LITERATURE_REPORT_MODEL POLARIS_LITERATURE_REASONING_EFFORT \
  POLARIS_LITERATURE_REPORT_REASONING_EFFORT \
  POLARIS_LITERATURE_GRAPHVIZ_BIN \
  POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY POLARIS_LITERATURE_DEEPSEC_API_URL \
  POLARIS_LITERATURE_CROSSREF_API_URL \
  CODEX_BIN CODEX_MODEL DEEPSEC_API_URL CROSSREF_API_URL \
  SEMANTIC_SCHOLAR_API_KEY DISPLAY \
  CODEX_CLI BROWSER_BACKEND BROWSER_CAMOFOX_URL BROWSER_PROXY_SERVER \
  BROWSER_PROXY_USERNAME BROWSER_PROXY_PASSWORD; do
  if [[ "${!_key+x}" == x ]]; then
    _POLARIS_LITERATURE_PRESENT["$_key"]=1
    _POLARIS_LITERATURE_SAVED["$_key"]="${!_key}"
  fi
done

if [[ -n "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" ]] || {
    echo "error: POLARIS_LITERATURE_ENV_FILE does not exist: $ENV_FILE" >&2
    exit 2
  }
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

for _key in "${!_POLARIS_LITERATURE_PRESENT[@]}"; do
  export "$_key=${_POLARIS_LITERATURE_SAVED[$_key]}"
done

# Common tools consume stable compatibility aliases only inside their own
# process. The public configuration remains POLARIS_LITERATURE_*.
export CODEX_BIN="${POLARIS_LITERATURE_CODEX_BIN:-${CODEX_BIN:-}}"
export CODEX_CLI="${POLARIS_LITERATURE_CODEX_CLI:-$TOOLS_ROOT/codex/clue-codex-cli}"
export CODEX_MODEL="${POLARIS_LITERATURE_CODEX_MODEL:-${CODEX_MODEL:-}}"
export LITERATURE_REVIEW_MODEL="${POLARIS_LITERATURE_ANALYSIS_MODEL:-${LITERATURE_REVIEW_MODEL:-$CODEX_MODEL}}"
export INTELLIGENCE_ANALYSIS_MODEL="${POLARIS_LITERATURE_ANALYSIS_MODEL:-${INTELLIGENCE_ANALYSIS_MODEL:-$CODEX_MODEL}}"
export REPORT_WRITING_MODEL="${POLARIS_LITERATURE_REPORT_MODEL:-${REPORT_WRITING_MODEL:-$CODEX_MODEL}}"
export LITERATURE_REVIEW_REASONING_EFFORT="${POLARIS_LITERATURE_REASONING_EFFORT:-${LITERATURE_REVIEW_REASONING_EFFORT:-medium}}"
export REPORT_WRITING_REASONING_EFFORT="${POLARIS_LITERATURE_REPORT_REASONING_EFFORT:-${REPORT_WRITING_REASONING_EFFORT:-${POLARIS_LITERATURE_REASONING_EFFORT:-medium}}}"
export SEMANTIC_SCHOLAR_API_KEY="${POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY:-${SEMANTIC_SCHOLAR_API_KEY:-}}"
export DEEPSEC_API_URL="${POLARIS_LITERATURE_DEEPSEC_API_URL:-${DEEPSEC_API_URL:-}}"
export CROSSREF_API_URL="${POLARIS_LITERATURE_CROSSREF_API_URL:-${CROSSREF_API_URL:-}}"
export LITERATURE_PDF_CACHE="${POLARIS_LITERATURE_PDF_CACHE:-${LITERATURE_PDF_CACHE:-}}"

# A selected file must not reintroduce the retired Wanghai environment.
for _key in "${!WANGHAI_@}"; do
  unset "$_key"
done

polaris_literature_assert_local_command() {
  local command="${1:-}"
  if [[ "${POLARIS_LITERATURE_RUNTIME_MODE:-local}" != "polaris" ]]; then
    return 0
  fi
  case "$command" in
    version|validate-input|validate-output|templates)
      return 0
      ;;
    *)
      echo "error: integrated literature tools require a Polaris durable job" >&2
      return 2
      ;;
  esac
}

export POLARIS_LITERATURE_TOOLS_ROOT="$TOOLS_ROOT"
