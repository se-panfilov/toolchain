# GitHub Actions

Toolchain has three GitHub Actions workflows for tests, builds, and npm releases.
Each workflow can use all applications or one application from `apps/`.
Each workflow has a dry-run mode.

| Workflow                                    | Start                                                            | Result                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Tests](../.github/workflows/test.yml)      | Pull request, push to `master`, manual start, call from Release. | Formatting, lint, workflow checks, and application tests on three OSs.      |
| [Build](../.github/workflows/build.yml)     | Manual start, call from Release.                                 | Type check, Vite build, `npm pack`, archive checks, and an archive bin run. |
| [Release](../.github/workflows/release.yml) | Manual start only.                                               | Tests, build, npm publication, Git tag, and GitHub Release.                 |

## Manual start

1. Open the repository on GitHub.
2. Open **Actions** and select the workflow.
3. Click **Run workflow**.
4. Select the branch.
5. Select the application in `app`. Select `all` for all applications.
6. Set `dry_run`.
7. Click **Run workflow**.

Only users with write access to the repository can start a workflow manually.

## Inputs

| Input     | Values                                  | Default                                          |
| --------- | --------------------------------------- | ------------------------------------------------ |
| `app`     | `all` or a directory name from `apps/`. | `all`                                            |
| `dry_run` | `true` or `false`.                      | `false` for Tests and Build. `true` for Release. |

Pull requests and pushes to `master` start Tests with `app=all` and `dry_run=false`.

The `plan` job of each workflow checks the input again with [scripts/ci/apps.mjs](../scripts/ci/apps.mjs).
It accepts only `all` or the exact directory name.
It does not accept a package name, a path, or a different letter case.

## Dry-run mode

| Workflow | `dry_run=true`                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Tests    | The workflow shows the selected applications. It does not install dependencies or run tests.                                            |
| Build    | The workflow builds, packs, and checks the archives. It does not upload workflow artifacts.                                             |
| Release  | The workflow runs tests and the build, and runs `npm publish --dry-run`. It does not publish, create a tag, or create a GitHub Release. |

A Release dry run gets no OIDC token and does not use the `npm-publish` environment.
It can start from any branch.

## Release

The Release workflow does these steps:

1. The `plan` job reads the version of each selected application.
2. It asks the npm registry for that exact version. Published versions are skipped.
3. If no version remains, the workflow stops after `plan`.
4. The Tests and Build workflows run for the selected `app`.
5. The `publish` job downloads the archive from Build and checks it again.
6. It publishes that archive with `npm publish --provenance --ignore-scripts`.
7. The `github-release` job creates the tag `<package>@<version>` on the tested commit.
8. It creates a GitHub Release and attaches the published archive.

Real publication is possible only from `refs/heads/master`.
Other branches stop in `plan` unless `dry_run` is `true`.
The workflow does not change versions.
Increase the version with the [version policy](PACKAGES.md#version-policy) and merge it to `master` first.

### npm trusted publishing

Publication uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) with OIDC.
The repository does not store an npm token.
Do these steps once for each package on npmjs.com:

1. Open the package settings.
2. Add a trusted publisher of type GitHub Actions.
3. Set the owner to `se-panfilov` and the repository to `toolchain`.
4. Set the workflow filename to `release.yml`.
5. Set the environment to `npm-publish`.
6. After the first successful release, set publishing access to require trusted publishers and disallow tokens.

A new package must exist in the registry before you can add a trusted publisher.
Publish its first version manually with the application release command.

### The npm-publish environment

The `publish` job uses the GitHub environment `npm-publish`.
GitHub makes the environment automatically at the first use, without protection rules.
Configure it in **Settings → Environments → npm-publish**:

1. Add yourself as a required reviewer.
2. Limit deployment branches to `master`.

Then each real publication waits for manual approval.

### Recovery

The archive check compares the npm `dist.integrity` value with the built archive.
If a version is already published with the same archive, `publish` skips publication.
If a version is published with a different archive, the job stops. Increase the version.

If `github-release` fails after publication, use **Re-run failed jobs** in the same workflow run.
That run uses the same archive. A new workflow run skips the published version and does not create the GitHub Release.
In that case, create the tag and the release manually from the commit in the workflow summary.

After a network error during publication, examine the registry before a new start.

## Security controls

| Control                | Implementation                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| Token permissions      | The default is `contents: read`. Release sets `{}` and gives each job only the necessary permissions.     |
| OIDC token             | Only the real `publish` job has `id-token: write`. It does not install dependencies or run builds.        |
| Write access to GitHub | Only `github-release` has `contents: write`. It does not install dependencies.                            |
| Checkout credentials   | All jobs use `persist-credentials: false`.                                                                |
| Actions                | Each action is pinned to a full commit SHA with the version in a comment.                                 |
| Input handling         | Inputs go to scripts through environment variables, not through `${{ }}` in shell text.                   |
| Dependency scripts     | `npm ci`, `npm pack`, and `npm publish` use `--ignore-scripts`. No dependency cache is used.              |
| Archive checks         | Paths, entry types, package metadata, bin entry points, install scripts, and secret patterns are checked. |
| Archive identity       | The publish job compares the archive integrity with the value recorded by Build.                          |
| Concurrency            | Only one Release run is active at a time. A new run waits.                                                |

Limits:

- The secret pattern check finds only common token and key formats. It does not prove that an archive has no secrets.
- Pull requests from forks run Tests with a read-only token and no secrets. They run the code from the pull request.
- The Linux test job downloads Git source from kernel.org and checks its SHA-256 value.
- Tests use only Node.js 26. CI does not check the minimum engine version, such as Node.js 24.12.0 for reHistory. Check it locally before you change that requirement.
- GitHub-hosted runners and the pinned actions are trusted.
- The locked development dependencies run in the test and build jobs and are trusted. They can change the built archive. The `min-release-age` setting in `.npmrc` delays new dependency versions.
- The tag check runs after publication. If a tag with the same name points to a different commit, `github-release` stops after npm publication.
- Users with write access can start Release. Use the environment protection rules to add an approval step.

## Add, remove, or rename an application

**CAUTION: Update all three workflows when you change the application list in `apps/`.**

Each workflow has its own `app` list under `workflow_dispatch.inputs.app.options`:

- [test.yml](../.github/workflows/test.yml)
- [build.yml](../.github/workflows/build.yml)
- [release.yml](../.github/workflows/release.yml)

The list starts with `all`. The application directory names follow in code point order, as `ls` with `LC_ALL=C` shows them.
GitHub does not let a workflow make choice values automatically.

| Change                | Necessary workflow change                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Add an application    | Add its directory name to the three lists.                                                                                                   |
| Remove an application | Remove its directory name from the three lists.                                                                                              |
| Rename the directory  | Replace the old name in the three lists. The package name and the Git tag prefix also change. Add the trusted publisher for the new package. |

Run this command after the change:

```sh
npm run check:workflows
```

The command compares the three lists with `apps/` and runs the tests for the workflow scripts.
The `plan` job of each workflow does the same comparison and stops on a difference.
`npm run check` also runs this command.

Each application must also have:

- A package name `tx-<lowercase-directory-name>`, as [AGENTS.md](../AGENTS.md) specifies.
- A version in the form `X.Y.Z`. Prerelease versions are not supported by the workflows.
- A `bin` object. Each entry point starts with `#!/usr/bin/env node`.
- The `build`, `typecheck`, `test`, and `start` scripts. The `start` script must accept `--help`.

## Local commands

```sh
npm run check:workflows
APP=reHistory OUT_DIR="$PWD/../release-check" node scripts/ci/package.mjs
```

The second command needs a completed build. It packs the application, checks the archive, and runs its bin from the archive.
`OUT_DIR` must be an absolute path that does not exist.
Do not run `scripts/ci/release.mjs` locally without `DRY_RUN=true`.
