# Developer Guide

## Prerequisites

- Node.js ≥ 20.19.0 or ≥ 22.12.0 (`@salesforce/mcp` engine requirement — v20.18.x is **not** sufficient)
- npm 10+
- VS Code 1.120+

## Local Development

```bash
npm install          # install dependencies
npm run watch        # compile TypeScript in watch mode
```

Press `F5` in VS Code to launch the Extension Development Host.

## Scripts

| Command | Description |
|---|---|
| `npm run bundle` | Bundle with esbuild (development) |
| `npm run compile` | Type-check via `tsc` |
| `npm run lint` | Run ESLint |
| `npm test` | Run the test suite |
| `npm run package` | Build production VSIX |

## Security Audit

The [audit workflow](.github/workflows/audit.yml) runs `npm audit --audit-level=high` on every push and weekly (Monday 06:00 UTC).

To check locally:

```bash
npm audit --audit-level=high
```

Transitive devDependency vulnerabilities are pinned via the `overrides` block in `package.json`. When new advisories appear, update the pinned versions there.

## Release Procedure

Releases are automated via the [release workflow](.github/workflows/release.yml). Pushing a `v*` tag triggers the workflow, which:

1. Runs `npm run package` to produce the `.vsix`
2. Creates a GitHub Release named after the tag
3. Attaches the `.vsix` as a downloadable asset
4. Auto-generates release notes from commits since the previous tag

### Steps

**1. Bump the version in `package.json`**

Use `npm version` to update the version and create a git commit automatically:

```bash
npm version patch   # 0.1.0 → 0.1.1  (bug fixes)
npm version minor   # 0.1.0 → 0.2.0  (new features)
npm version major   # 0.1.0 → 1.0.0  (breaking changes)
```

This updates `package.json`, commits the change, and creates a local tag.

**2. Push the commit and the tag**

```bash
git push origin main --tags
```

The release workflow starts automatically on GitHub Actions.

**3. Verify the release**

Check [Actions](https://github.com/alcabon/salesforce-copilot-inspector/actions) for the workflow run, then confirm the `.vsix` asset appears on the [Releases page](https://github.com/alcabon/salesforce-copilot-inspector/releases).

### Re-tagging a broken release

If the workflow ran against the wrong commit (e.g. the tag was pushed before a fix was committed):

```bash
git tag -d v0.1.0                  # delete local tag
git push origin :refs/tags/v0.1.0  # delete remote tag
git tag v0.1.0                     # re-create at HEAD
git push origin v0.1.0             # push → re-triggers workflow
```

Then delete any duplicate `.vsix` assets from the release page using the edit (pencil) button.

### Installing a local VSIX

```bash
code --install-extension salesforce-copilot-inspector-0.1.0.vsix
```
