#!/usr/bin/env bash
# Shared logging functions for hack/ scripts.
# Source this file: source "$(dirname "${BASH_SOURCE[0]}")/lib/log.sh"

_LOG_COLOR_RESET='\033[0m'
_LOG_COLOR_GREEN='\033[0;32m'
_LOG_COLOR_YELLOW='\033[0;33m'
_LOG_COLOR_RED='\033[0;31m'
_LOG_COLOR_CYAN='\033[0;36m'
_LOG_COLOR_BOLD='\033[1m'

_log_script_name() {
  basename "${BASH_SOURCE[2]:-${BASH_SOURCE[1]:-unknown}}" .sh
}

log::step() {
  local script
  script=$(_log_script_name)
  echo
  echo -e "${_LOG_COLOR_BOLD}${_LOG_COLOR_CYAN}[${script}] $*${_LOG_COLOR_RESET}"
  echo
}

log::info() {
  local script
  script=$(_log_script_name)
  echo -e "${_LOG_COLOR_GREEN}[${script}]${_LOG_COLOR_RESET} $*"
}

log::warn() {
  local script
  script=$(_log_script_name)
  echo -e "${_LOG_COLOR_YELLOW}[${script}] WARNING:${_LOG_COLOR_RESET} $*" >&2
}

log::error() {
  local script
  script=$(_log_script_name)
  echo -e "${_LOG_COLOR_RED}[${script}] ERROR:${_LOG_COLOR_RESET} $*" >&2
}

log::waiting() {
  local script
  script=$(_log_script_name)
  echo -e "[${script}] $*"
}

log::link() {
  local label="$1" url="$2"
  echo -e "  ${_LOG_COLOR_BOLD}${label}${_LOG_COLOR_RESET}  \033[4m${url}${_LOG_COLOR_RESET}"
}

log::hint() {
  echo -e "  $*"
}
