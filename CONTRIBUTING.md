# Contributing & release flow

## Branching model

- **`main`** — always shippable. Every commit on `main` corresponds to a
  releasable state. Protected: no direct pushes.
- **`develop`** — integration branch. Features land here first.
- **feature branches** — `feature/<short-name>` (or `fix/…`), branched from
  `develop`.

```
feature/* ──PR──▶ develop ──PR──▶ main ──tag──▶ release
   (squash)          (squash)        (vX.Y.Z)
```

## Pull requests

1. Branch from `develop`.
2. Open a PR **into `develop`**.
3. CI (`.github/workflows/ci.yml`) must pass: typecheck, lint, tests, build, and
   `web-ext lint`.
4. **Squash-merge only.** This keeps `develop` and `main` history linear and
   each merge a single logical change. (Configure the repo to allow only squash
   merges: _Settings → General → Pull Requests_.)

## Cutting a release

1. Open a PR from `develop` into `main` and **squash-merge** it once green.
2. Bump the version in **both** `package.json` and `src/manifest.json`
   (keep them in sync) — typically as part of that PR.
3. Tag the merge commit on `main`:

   ```bash
   git checkout main && git pull
   git tag v0.1.0
   git push origin v0.1.0
   ```

4. The tag triggers `.github/workflows/release.yml`, which builds the extension,
   packages it with `web-ext`, and attaches the artifact to a GitHub Release.

Tags must match `v*` (e.g. `v0.1.0`). Use [semantic versioning](https://semver.org/).

## Branch protection (recommended settings)

On `main`:
- Require a pull request before merging.
- Require status checks to pass (`build-and-test`).
- Allow **squash merging only**; disable merge commits and rebase merging.

## Code layout

| Path | Responsibility |
| --- | --- |
| `src/core/` | Pure, framework-free logic (unit-tested directly). |
| `src/platform/` | Thin `messenger.*` wrappers (tested with a mocked global). |
| `src/background/` | Event-page job state machine + request routing. |
| `src/ui/`, `src/options/` | Extension pages. |
| `test/` | Vitest suites. |
| `scripts/build.mjs` | esbuild bundling + static asset copy → `dist/`. |

Keep new business logic in `src/core/` (and tested) wherever possible; the
platform layer should stay a thin adapter.
