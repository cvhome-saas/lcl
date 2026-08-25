# Release checklist

- `npm ci`, `npm run check`, `npm test`, and `npm pack --dry-run` pass.
- The packed tarball contains only the declared runtime files.
- The minimal lifecycle passes on macOS, Linux, and WSL2.
- Docker Compose start, health, port shifting, normal stop, and `--hard` volume cleanup pass on Linux.
- The tag is `v<package-version>` and `CHANGELOG.md` describes the release.
- npm trusted publishing points at `cvhome-saas/lcl` and `.github/workflows/publish.yml`.
