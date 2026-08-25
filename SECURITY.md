# Security policy

Report vulnerabilities privately through GitHub Security Advisories for `cvhome-saas/lcl`.

An `lcl.yml` is trusted local code: commands, shell hooks, and preparation steps execute with the developer's user
permissions. Review configuration from an untrusted repository before running `lcl start`.

The runner must only signal verified process groups it owns and must scope Docker cleanup to its exact Compose project.
