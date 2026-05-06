# Releasing (maintainers)

This document is the maintainer release procedure for automerge-gate. All releases are cut from the GitHub web UI. There is no release script and no `npm publish` step.

## Pre-release checklist

1. `main` is green on CI.
2. `dist/index.js` is in sync with `src/`. The pre-commit hook keeps it in sync; if in doubt run:
   ```bash
   npm run build
   git diff --exit-code dist/   # should be empty
   ```

## Cutting a release

1. Go to **Releases → Draft a new release**.
2. **Choose a tag**: type the new version (e.g. `v3.0.0`) and select *Create new tag on publish*.
3. **Target**: `main`.
4. **Release title**: same as the tag (e.g. `v3.0.0`).
5. Click **Generate release notes** to autopopulate from PRs / commits since the last tag.
6. **Set as the latest release**: tick the box.
7. **Mark as an immutable release** (Public Preview): tick if the option is shown — locks the tag and asset checksums so they cannot be silently rewritten later.
8. **Publish to GitHub Marketplace**: tick on the **first** release only. Subsequent releases auto-update the existing Marketplace listing.
9. Click **Publish release**.

## After publishing

Users pin a fixed version: `uses: pkgdeps/automerge-gate@v3.0.0`. Renovate / Dependabot will open update PRs as new versions ship.

---

See the [README](../README.md) for usage.
