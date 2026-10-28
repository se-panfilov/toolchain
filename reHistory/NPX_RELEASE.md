# Publish reHistory for npx

Document date: 2026-10-29.

## Purpose

Use this procedure to make reHistory available through the public npm registry.
After publication, the command can start from any directory.
The source checkout is not necessary on the user machine.
A public Git repository is not necessary for npm publication.
Node.js, npm, and Git are still necessary.

This procedure uses a package in your personal npm scope.
The example package name is `@se-panfilov/rehistory`.
The bin name stays `rehistory`.
An organization scope is an alternative if you have publication permission for that organization.

The procedure uses English under the project [documentation rules](TERMINOLOGY.md).
The program interface stays in Russian.

## Initial package state

The source package already has these items:

| Item | Value or purpose |
| --- | --- |
| Source directory | `toolchain/reHistory` |
| Initial package name | `rehistory` |
| Publication guard | `private: true` |
| Bin | `rehistory` points to `dist/cli.js` |
| Module format | `type: module` |
| Node.js requirement | `>=24.12.0` |
| Build command | `npm run build` |
| Package hook | `prepack` makes the JavaScript build. |
| Runtime dependencies | None. |
| Package contents | Six JavaScript modules, documentation, license, and package metadata. |

Do not start with `npm init`.
The package metadata is in place.
Do not make another Git repository inside the package directory.

## Example values

Replace all uppercase placeholders before you use a command.
Put paths that contain spaces in quotes.

| Placeholder | Required value |
| --- | --- |
| `se-panfilov` | Your npm account name from `npm whoami`. |
| `VERSION` | The exact release version in `package.json`. |
| `ARCHIVE_PATH` | The absolute path of the archive printed by `npm pack`. |
| `/path/to/toolchain/reHistory` | The source package directory. |
| `/path/to/rehistory-release` | A new release directory external to Toolchain. |
| `/path/to/project` | A Git repository selected for audit or a dry-run. |

Use the same package name and version throughout this procedure.
Do not add the literal placeholder `VERSION` to package metadata.

## 1. Prepare the tools

1. Open the source package directory.

   ```sh
   cd /path/to/toolchain/reHistory
   ```

2. Read the Node.js version.

   ```sh
   node --version
   ```

3. Make sure that the version is 24.12 or later.
4. Read the npm version.

   ```sh
   npm --version
   ```

5. Read the Git version.

   ```sh
   git --version
   ```

6. Make sure that Git is 2.39 or later.

Use a supported npm version that comes with your Node.js installation.
The local release checks used npm 11.
An interactive ANSI terminal is necessary for a history change or an export.
A network connection is necessary for authentication and publication.

## 2. Prepare the npm account

1. Open [npm account creation](https://www.npmjs.com/signup).
2. Make an account if you do not have one.
3. Complete the email verification.
4. Enable two-factor authentication in the account settings.
5. Keep the account recovery data in a restricted location.

Use the browser authentication method for this manual procedure.
A publication token is not necessary.
The npm account must have publication permission for the selected scope.

Read the [npm 2FA instructions](https://docs.npmjs.com/configuring-two-factor-authentication/) if account configuration is necessary.

## 3. Authenticate the CLI

1. Start browser authentication against the public registry.

   ```sh
   npm login --auth-type=web --registry=https://registry.npmjs.org/
   ```

2. Complete the steps in the browser.
3. Read the authenticated account name.

   ```sh
   npm whoami --registry=https://registry.npmjs.org/
   ```

4. Write this account name as your `se-panfilov` value.

If the displayed account is incorrect, stop.
Do not put account passwords or access tokens in the project or release archive.

The browser procedure follows the [npm CLI authentication instructions](https://docs.npmjs.com/accessing-npm-using-2fa/).

## 4. Select the package name

1. Read the registry entry for your selected name.

   ```sh
   npm view "@se-panfilov/rehistory" name version maintainers --json --registry=https://registry.npmjs.org/
   ```

2. Examine any package that the registry returns.
3. Make sure that your account has permission to publish that package.

For a new name, an `E404` response can indicate that no package is visible at that name.
An `E404` response alone does not give publication permission.
Authentication and scope ownership are also necessary.
Stop for a network, authentication, or permission error.

A personal scope gives you a name under your account.
It does not require ownership of the unscoped name `rehistory`.
The [npm scope guide](https://docs.npmjs.com/about-public-packages/) explains these names.

## 5. Prepare package metadata

**CAUTION: Continue only if this code can be public.**
A public package makes its JavaScript files, documentation, and package metadata available.
The local `private` guard is different from npm registry access.

1. Make sure that the current directory is the source package directory.
2. Set the scoped package name.

   ```sh
   npm pkg set "name=@se-panfilov/rehistory"
   ```

3. Set public access for publication.

   ```sh
   npm pkg set "publishConfig.access=public"
   ```

4. Set the publication registry.

   ```sh
   npm pkg set "publishConfig.registry=https://registry.npmjs.org/"
   ```

5. Remove the publication guard.

   ```sh
   npm pkg delete private
   ```

6. Read the resulting metadata.

   ```sh
   npm pkg get name version private type engines bin publishConfig files
   ```

7. Make sure that `private` is absent.
8. Make sure that `bin.rehistory` is `dist/cli.js`.
9. Make sure that `type` is `module`.
10. Make sure that the registry is `https://registry.npmjs.org/`.
11. Make sure that the publication access is `public`.

Do not use `npm pkg set private=false` without JSON parsing.
That command can write a string rather than a Boolean.
Deletion removes this ambiguity.

Keep the exact package file allowlist.
Do not replace the allowlist with the complete source directory.
Keep the existing license text.

For the metadata command syntax, refer to [npm pkg](https://docs.npmjs.com/cli/v11/commands/npm-pkg/).

## 6. Select a release version

1. Read the local version.

   ```sh
   npm pkg get version
   ```

2. Read the published versions for your package name.

   ```sh
   npm view "@se-panfilov/rehistory" versions --json --registry=https://registry.npmjs.org/
   ```

3. Select a version that has not been published under this package name.

For a new package, you can keep the current local version.
For an update, increase the version before you make the archive.
For a patch update, use this command:

```sh
npm version patch --no-git-tag-version
```

This option prevents npm from making a Git commit or Git tag.
The current package has no version lifecycle scripts.
If you add such scripts, examine their actions before a version change.

Write the resulting version as your `VERSION` value.
The [npm version reference](https://docs.npmjs.com/cli/v11/commands/npm-version/) describes this option.

## 7. Test the source package

1. Do the implementation tests.

   ```sh
   npm test
   ```

2. Stop if a test reports an error.
3. Make the JavaScript build.

   ```sh
   npm run build
   ```

4. Start the built command without a registry.

   ```sh
   node dist/cli.js --help
   ```

5. Make sure that the help text is in Russian.

The build uses the existing TypeScript source.
The published package must contain JavaScript, not executable TypeScript in `node_modules`.
The build can show an experimental API warning.
That warning is not a test result.
The build does not do a TypeScript type check.

The bin entry must start with `#!/usr/bin/env node`.
The build sets its executable file mode.
The [npm package reference](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/) describes the bin field.

## 8. Make the release archive

**CAUTION: Examine the archive before publication.**
Do not publish credentials, personal repository data, or unrelated files.

1. Examine the package file plan.

   ```sh
   npm pack --dry-run --json
   ```

2. Make a new release directory external to the source.

   ```sh
   mkdir /path/to/rehistory-release
   ```

3. Make the archive in that directory.

   ```sh
   npm pack --pack-destination /path/to/rehistory-release --json
   ```

4. Write the archive path as your `ARCHIVE_PATH` value.
5. Write the report value `integrity` in your release notes.
6. List the archive contents.

   ```sh
   tar -tzf "ARCHIVE_PATH"
   ```

7. Read the archived package metadata.

   ```sh
   tar -xOf "ARCHIVE_PATH" package/package.json
   ```

8. Make sure that the archived name and version match your selected release.
9. Make sure that the archived package has no `private: true` value.
10. Make sure that the archive contains all required files.

The archive must include these files:

```text
package/package.json
package/LICENSE
package/README.md
package/SECURITY.md
package/TERMINOLOGY.md
package/NPX_RELEASE.md
package/dist/cli.js
package/dist/engine.js
package/dist/audit.js
package/dist/export.js
package/dist/demo.js
package/dist/prompts.js
```

The archive must not include `.git`, `.npmrc`, source repositories, recovery files, or demo data.
TypeScript source files must not be necessary at runtime.

`npm pack` starts the existing `prepack` build.
Keep this tested archive for publication.
Do not change its contents after the check.
The [npm pack reference](https://docs.npmjs.com/cli/v11/commands/npm-pack/) describes archive creation.

## 9. Test the archive through npx

1. Make an empty test directory.

   ```sh
   mkdir /path/to/rehistory-release/archive-test
   ```

2. Open that directory.

   ```sh
   cd /path/to/rehistory-release/archive-test
   ```

3. Start the bin from the local archive.

   ```sh
   npx --offline --yes --cache=/path/to/rehistory-release/archive-cache --package="ARCHIVE_PATH" rehistory --help
   ```

4. Make sure that the help text is in Russian.
5. Do a read-only audit of a selected repository.

   ```sh
   npx --offline --yes --cache=/path/to/rehistory-release/archive-cache --package="ARCHIVE_PATH" rehistory --audit --repo "/path/to/project"
   ```

6. Examine the audit result.

The local archive test does not need an npm registry connection.
The package has no runtime dependencies.
The dedicated cache prevents confusion with a previous local installation.

The npm option `--yes` accepts package installation.
It does not give reHistory permission to change Git history.
Do not start a demo as a publication smoke test.
The demo sends data to a server.

## 10. Publish the tested archive

**CAUTION: The next procedure writes a public package to npm.**
A published name and version cannot be reused for different contents.

1. Make sure that the source tests and archive checks passed.
2. Make sure that you selected the correct account, package name, and version.
3. Make sure that the archive is the same file tested in section 9.
4. Do the publication dry-run.

   ```sh
   npm publish "ARCHIVE_PATH" --dry-run --access public --tag latest --registry=https://registry.npmjs.org/
   ```

5. Examine the name, version, file list, and registry in the result.
6. Publish that archive only if the result is correct.

   ```sh
   npm publish "ARCHIVE_PATH" --access public --tag latest --registry=https://registry.npmjs.org/
   ```

7. Complete the npm authentication challenge.
8. Make sure that npm reports the selected package name and version.

This procedure uses interactive account authentication with 2FA.
It does not use a token that bypasses 2FA.
The [npm publication requirements](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/) give the authentication rules.
The [npm publish reference](https://docs.npmjs.com/cli/v11/commands/npm-publish/) describes archive publication and immutable versions.

The npm tag `latest` identifies the default release.
It is not a Git tag.
It does not pin a version for a later npx invocation.

## 11. Verify the registry result

1. Read the exact published version.

   ```sh
   npm view "@se-panfilov/rehistory@VERSION" name version bin engines dist.integrity --json --registry=https://registry.npmjs.org/
   ```

2. Compare `dist.integrity` with the `integrity` value from section 8.
3. Stop if the values differ.
4. Make sure that the name, version, bin, and Node.js requirement are correct.
5. Make a new test directory.

   ```sh
   mkdir /path/to/rehistory-release/registry-test
   ```

6. Open that directory.

   ```sh
   cd /path/to/rehistory-release/registry-test
   ```

7. Start the exact registry version with a new cache.

   ```sh
   npx --yes --registry=https://registry.npmjs.org/ --cache=/path/to/rehistory-release/registry-cache --package="@se-panfilov/rehistory@VERSION" rehistory --help
   ```

8. Make sure that the help text appears without the Toolchain checkout as the current directory.

This cache is different from the archive test cache.
The check therefore uses the published package, not the local archive installation.
The [npm exec reference](https://docs.npmjs.com/cli/commands/npm-exec/) describes package selection and cache use.

## 12. Use npx from any directory

A public package user does not need an npm account for a normal download.
The machine still needs Node.js 24.12 or later and Git 2.39 or later.
The first download needs registry access.
An exact version gives a repeatable package selection.

### Read-only audit

```sh
npx --package="@se-panfilov/rehistory@VERSION" rehistory --audit --repo "/path/to/project"
```

### History change dry-run

An interactive terminal is also necessary for this dry-run.

```sh
npx --package="@se-panfilov/rehistory@VERSION" rehistory --dry-run --repo "/path/to/project"
```

### History change

**CAUTION: Keep a backup before the history change.**
Use an interactive terminal.

```sh
npx --package="@se-panfilov/rehistory@VERSION" rehistory --repo "/path/to/project"
```

### Export

```sh
npx --package="@se-panfilov/rehistory@VERSION" rehistory --repo "/path/to/project" --export "/path/to/new-export.git"
```

### Short command

The package has one bin entry.
For that package, npm can select the bin without an explicit `--package` option.

```sh
npx "@se-panfilov/rehistory@VERSION" --help
```

Put npx options before the package or bin name.
Put reHistory options after the bin name.
Without `--repo`, reHistory selects the current directory.
A global installation is not necessary.

### Alternative: an unscoped name

If you control the unscoped name `rehistory`, you can keep that name.
Omit only the scoped name change in section 5.
Replace the scoped name in later commands with `rehistory`.
The other archive and publication checks remain necessary.

```sh
npx "rehistory@VERSION" --help
```

The bin name alone does not select your registry package.
Do not substitute `npx rehistory` for this command.
That command selects a package named `rehistory`.

## 13. Publish another version

1. Open the source package directory.
2. Make the required source changes.
3. Increase the version without a Git commit or tag.

   ```sh
   npm version patch --no-git-tag-version
   ```

4. Repeat sections 7 through 11 with the new version and a new release directory.
5. Update the version in commands that users copy.

Do not try to replace an old name and version with a different archive.
Do not remove an old version to make its number available again.
The npm version identity remains immutable after removal.

## Troubleshooting

| Result | Action |
| --- | --- |
| `ENEEDAUTH` or an expired session | Repeat browser login against the public registry. |
| `E403` | Examine account permission, scope ownership, and the selected registry. |
| `EPRIVATE` | Remove the private guard before archive creation. |
| The version is present in npm | Select a new version and repeat the archive checks. |
| npm cannot determine an executable | Examine the archived bin field and JavaScript path. |
| A TypeScript error mentions `node_modules` | Make the JavaScript build and examine the archive contents. |
| An engine error | Use Node.js 24.12 or later. |
| A TTY error | Use an interactive ANSI terminal for a change or export. |
| Old package behavior | Use an exact version and a different cache directory. |
| Publication integrity differs | Stop and examine the archive, package name, and registry version. |

## Later automation

This procedure is for manual publication.
It does not configure CI credentials or automatic publication.
For CI, examine [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) before you add long-lived tokens.
The npm token policy changes independently of this project.
Do not base a new workflow on legacy tokens.

## Completion criteria

The release is ready for npx use when these conditions are true:

- The exact package name and version are visible in the public registry.
- The registry integrity matches the tested archive.
- The bin starts from a directory external to the source checkout.
- The read-only audit operates on an explicitly selected repository.
- Russian prompts and safe confirmation defaults remain available.

## References

- [Public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).
- [Package metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/).
- [Metadata commands](https://docs.npmjs.com/cli/v11/commands/npm-pkg/).
- [Archive creation](https://docs.npmjs.com/cli/v11/commands/npm-pack/).
- [Package publication](https://docs.npmjs.com/cli/v11/commands/npm-publish/).
- [Version changes](https://docs.npmjs.com/cli/v11/commands/npm-version/).
- [npx and npm exec](https://docs.npmjs.com/cli/commands/npm-exec/).
