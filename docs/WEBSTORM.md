# WebStorm setup

Toolchain uses JetBrains WebStorm as its only supported editor.
Give editor settings and instructions for WebStorm only.
The ignore files and the structure check keep their protection for files of other editors. See [Enforced rules](ENFORCED_RULES.md).

## Project settings

The `.idea/` directory is not tracked. Each developer applies the settings below in the local project.
The repository configuration files remain the single source of rules. Do not copy their values into WebStorm settings.

## Before you open the project

WebStorm runs ESLint, Prettier, and TypeScript from the project `node_modules`. These tools load repository configuration files as code.
Open a branch from an unknown source in safe mode until you examine its configuration files and scripts.

1. Clone the repository.
2. Run `npm ci --ignore-scripts` from the repository root in a terminal.
3. Open the repository root directory in WebStorm.
4. Select **Trust Project** only after you examine the branch.

Do not run `npm install` from a WebStorm notification. That command can run installation scripts and change `package-lock.json`.

## Settings

Open **Settings** and set these values for the project:

| Setting path                                                      | Value                                                                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Languages & Frameworks > Node.js > Node interpreter               | A Node.js version that agrees with `.nvmrc` and the `engines` field of `package.json`.                                                     |
| Languages & Frameworks > Node.js > Package manager                | `npm` from the selected Node.js version.                                                                                                   |
| Languages & Frameworks > TypeScript > TypeScript                  | `node_modules/typescript` of the project, not the bundled version.                                                                         |
| Languages & Frameworks > JavaScript > Code Quality Tools > ESLint | **Automatic ESLint configuration**. WebStorm finds the root `eslint.config.mjs`.                                                           |
| Languages & Frameworks > JavaScript > Prettier                    | **Automatic Prettier configuration** and **Run on save**. Add `md,json,yml,yaml` to the file pattern.                                      |
| Editor > Code Style > General                                     | **Enable EditorConfig support**. WebStorm then applies `.editorconfig`.                                                                    |
| Version Control > Commit                                          | Keep **Run Git hooks** selected. The hooks check the branch name, formatting, secrets, and commit messages. See [Git hooks](GIT_HOOKS.md). |

Prettier uses the root `prettier.config.mjs` and `.prettierignore`. Do not format generated output or vendored skills.
ESLint uses `--max-warnings=0` in CI. Correct each warning that WebStorm shows.

## Excluded directories

Mark these directories as excluded to keep generated files out of search and indexing:

- `apps/*/dist`
- `coverage`
- `reports`

To exclude a directory, right-click it and select **Mark Directory as > Excluded**.

## Tests

WebStorm finds Vitest in the project `node_modules`.
To run all tests, create a **Vitest** run configuration with the root `vitest.config.mjs`.
To run the tests of one application, use the `vitest.config.mjs` file in its application directory.

Integration tests use the compiled CLI in `dist/`. Build the application before a direct Vitest run.
In the run configuration, add a **Before launch** step that runs the npm script `build` for the related workspace.
The root `npm test` command already builds each application before its tests.

## Commands

Use the WebStorm terminal or the **npm** tool window for the commands in [the workspace guide](WORKSPACES.md#commands).
Run them from the repository root.
