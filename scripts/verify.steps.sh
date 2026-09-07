# The gates CI runs (.github/workflows/ci.yml: test matrix + package job), in order. `step "<name>" <command...>`
# stops at the first failure. Keep identical to CI.
#
# Docker: the Compose and lifecycle suites need it. CI runs them on Ubuntu and sets CI_NO_DOCKER=1 on macOS;
# locally the same rule applies — when Docker is not reachable the Docker-backed tests are skipped and the run
# says so, and Compose behaviour has NOT been verified (AGENTS.md, Development commands).
if [ "${CI_NO_DOCKER:-}" != "1" ] && ! docker info >/dev/null 2>&1; then
  echo "  ! Docker is not reachable: running with CI_NO_DOCKER=1 — Compose/lifecycle tests are skipped, not verified"
  export CI_NO_DOCKER=1
fi
step "install (npm ci)"                     npm ci
step "typecheck (npm run check)"            npm run check
step "tests (npm test${CI_NO_DOCKER:+, CI_NO_DOCKER=1})" npm test
step "package contents (npm pack --dry-run)" npm pack --dry-run
step "diff is clean of whitespace errors"   git diff --check
