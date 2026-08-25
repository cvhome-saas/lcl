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

The first release bootstraps the npm package before trusted publishing can be attached:

1. Confirm the authenticated npm account has 2FA and write access to the `@cvhome-saas` scope.
2. Publish the first version once with `npm publish --access public`.
3. Run `npm trust github @cvhome-saas/lcl --file publish.yml --repo cvhome-saas/lcl --allow-publish` with npm 11.15+
   or configure the same fields in the package settings on npmjs.com.
4. Publish the matching GitHub release. The workflow accepts the existing bootstrap version; subsequent releases
   publish through short-lived OIDC credentials and receive npm provenance automatically.
