# Contributing

Use Node.js 22 or 24. Install dependencies with `npm install`, then run:

```bash
npm run check
npm test
npm pack --dry-run
```

Changes to `lcl.yml` must update `schema/lcl.schema.json`, parser tests, and the README together. Breaking schema
changes require a new top-level configuration `version`. Never make cleanup signal a process based only on a port or
an unverified stale PID.

Releases use `v<package-version>` tags. CI must pass and the packed file allowlist must be reviewed before creating a
GitHub release. npm trusted publishing then publishes the matching public package with provenance.
