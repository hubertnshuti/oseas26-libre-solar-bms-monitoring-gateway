#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
  configure)
    if [[ -e .env ]]; then
      echo '.env already exists; preserving it. Edit it deliberately if configuration must change.'
      exit 0
    fi
    command -v openssl >/dev/null || { echo 'Install OpenSSL before configuration.' >&2; exit 1; }
    umask 077
    mkdir -p .demo
    cp .env.example .env
    mysql_password=$(openssl rand -hex 24)
    jwt_secret=$(openssl rand -hex 32)
    mqtt_password=$(openssl rand -hex 24)
    app_key=$(openssl rand -base64 32)
    sed -i "s|^MYSQL_ROOT_PASSWORD=.*|MYSQL_ROOT_PASSWORD=$mysql_password|; s|^APP_KEY=.*|APP_KEY=base64:$app_key|; s|^JWT_SECRET=.*|JWT_SECRET=$jwt_secret|; s|^MQTT_PASSWORD=.*|MQTT_PASSWORD=$mqtt_password|" .env
    echo 'Created private .env. Review project name and ports before installation.'
    ;;
  install)
    [[ -f .env ]] || { echo 'Run bash deploy/demo.sh configure first.' >&2; exit 1; }
    if grep -q 'replace-with-generated-secret' .env; then
      echo 'Replace placeholder secrets before installation.' >&2
      exit 1
    fi
    docker compose config --quiet
    expected=ab3a466f90e25240ea83e9fdcdbcb36ef849a90f
    [[ $(git -C external/micropowermanager rev-parse HEAD) == "$expected" ]] || { echo 'Initialize the pinned MPM submodule first.' >&2; exit 1; }
    [[ -z $(git -C external/micropowermanager status --porcelain) ]] || { echo 'MPM submodule has local changes; inspect them before building.' >&2; exit 1; }
    docker compose build backend
    docker compose run --rm --no-deps dependencies
    docker compose build adapter
    docker compose build frontend
    docker compose run --rm --no-deps broker-init
    docker compose up -d --wait --wait-timeout 180 mysql redis
    docker compose run --rm --no-deps initialize
    docker compose up -d --wait --wait-timeout 300
    echo 'Services started. Complete Home Assistant onboarding using docs/quickstart.md.'
    ;;
  scenario)
    scenario=${2:-}
    case "$scenario" in
      normal-cycle|normal-charge|normal-discharge|cell-overvoltage|cell-undervoltage|over-temperature|increasing-cell-imbalance|missing-reading|connected-but-silent|disconnect-reconnect|recovery) ;;
      *) echo 'Choose a supported simulator scenario; see docs/demo.md.' >&2; exit 1 ;;
    esac
    # Compose restart does not apply changed environment/configuration.
    SIMULATOR_SCENARIO="$scenario" docker compose up -d --no-deps --force-recreate simulator
    ;;
  *)
    echo 'Usage: bash deploy/demo.sh configure|install|scenario SCENARIO' >&2
    exit 1
    ;;
esac
