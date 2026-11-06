import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  adapterProblems,
  aliasProblems,
  appTsconfigProblems,
  baseTsconfigProblems,
  configProblems,
  exactVersionProblems,
  frontmatter,
  lockfileProblems,
  manifestProblems,
  nvmrcProblems,
  requiredCompilerOptions,
  skillProblems,
  structureProblems,
  workflowRuleProblems
} from '../../scripts/ci/config.mjs';
import { readJson, root } from '../../scripts/ci/lib.mjs';

function temporary(t, prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const rootManifest = { engines: { node: '>=24.12.0' } };
const goodManifest = {
  name: 'tx-demoapp',
  version: '1.0.0',
  description: 'Demo',
  license: 'MIT',
  type: 'module',
  engines: { node: '>=24.12.0' },
  bin: { 'tx-demoapp': 'dist/src/cli.js' },
  files: ['dist/src/cli.js', 'README.md', 'LICENSE'],
  scripts: { build: 'node scripts/build.mjs', typecheck: 'tsc --noEmit', test: 'vitest run', start: 'npm run build && node dist/src/cli.js', prepack: 'npm run build' },
  exports: {},
  repository: { type: 'git', url: 'git+https://example.invalid/repo.git', directory: 'apps/demoApp' }
};
const exists = (path, prefix) => ['README.md', 'LICENSE', 'src/cli.ts'].includes(path) && (prefix === undefined || path === 'src/cli.ts');
const goodTsconfig = {
  extends: '../../configs/tsconfig.base.json',
  compilerOptions: { rootDir: '.', outDir: 'dist', paths: { '@demoApp/*': ['./src/*.ts'] } },
  include: ['src/**/*.ts', 'test/**/*.ts'],
  exclude: ['dist', 'node_modules']
};

test('the current repository passes the configuration check', async () => {
  assert.deepEqual(await configProblems(), []);
});

test('the base tsconfig keeps every required compiler option', () => {
  assert.deepEqual(baseTsconfigProblems({ compilerOptions: requiredCompilerOptions }), []);
  const problems = baseTsconfigProblems({ compilerOptions: { ...requiredCompilerOptions, strict: false, moduleResolution: 'Node' } });
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /strict/);
  assert.match(problems.join('\n'), /moduleResolution/);
  assert.equal(baseTsconfigProblems({}).length, Object.keys(requiredCompilerOptions).length);
});

test('an application tsconfig sets only local paths and its own alias', () => {
  assert.deepEqual(appTsconfigProblems('demoApp', goodTsconfig), []);
  const shared = { ...goodTsconfig, compilerOptions: { ...goodTsconfig.compilerOptions, paths: { '@demoApp/*': ['./src/*.ts'], '@shared/*': ['../../shared/*.ts'] } } };
  assert.deepEqual(appTsconfigProblems('demoApp', shared), []);
  const bad = {
    extends: './other.json',
    compilerOptions: { rootDir: 'src', outDir: 'lib', strict: false, paths: { '@/*': ['./src/*'], '@shared/*': ['../other/*'] } },
    include: ['test/**/*.ts'],
    exclude: ['dist']
  };
  const problems = appTsconfigProblems('demoApp', bad).join('\n');
  for (const pattern of [/extends/, /strict/, /rootDir/, /outDir/, /@\/\*/, /@shared/, /нет alias @demoApp/, /include/, /node_modules/]) assert.match(problems, pattern);
});

test('Vite and Vitest aliases must point to the application source', () => {
  const appRoot = resolve('/repo/apps/demoApp');
  const alias = { '@demoApp': join(appRoot, 'src') };
  assert.deepEqual(aliasProblems('demoApp', appRoot, alias, { ...alias, '@shared': resolve('/repo/shared') }), []);
  assert.equal(aliasProblems('demoApp', appRoot, { '@demoApp': join(appRoot, 'lib') }, undefined).length, 2);
  assert.equal(aliasProblems('demoApp', appRoot, alias, { ...alias, '@': join(appRoot, 'src') }).length, 1);
});

test('application metadata follows the package requirements', () => {
  assert.deepEqual(manifestProblems('demoApp', goodManifest, rootManifest, exists), []);
  const bad = {
    ...goodManifest,
    description: '',
    type: 'commonjs',
    engines: { node: '>=20' },
    files: ['dist', 'src/cli.ts', 'README.md'],
    exports: { '.': './dist/src/cli.js' },
    repository: { type: 'git', directory: 'apps/other' },
    scripts: { ...goodManifest.scripts, start: 'node dist/other.js', prepack: 'true', postinstall: 'node x.js' },
    dependencies: { chalk: '5.0.0' },
    devDependencies: { vitest: '5.0.0' }
  };
  const problems = manifestProblems('demoApp', bad, rootManifest, exists).join('\n');
  for (const pattern of [/description/, /type/, /engines/, /files dist/, /files src/, /LICENSE/, /exports/, /repository/, /start/, /prepack/, /postinstall/, /chalk/, /devDependencies/]) {
    assert.match(problems, pattern);
  }
  assert.match(manifestProblems('demoApp', goodManifest, rootManifest, (path) => path !== 'src/cli.ts' || false).join('\n'), /src\/cli\.ts/);
  assert.match(manifestProblems('demoApp', goodManifest, rootManifest, (path, prefix) => prefix === undefined).join('\n'), /#!\/usr\/bin\/env node/);
});

test('development dependencies use exact versions', () => {
  assert.deepEqual(exactVersionProblems('package.json', { devDependencies: { eslint: '10.13.0', next: '1.0.0-rc.1' } }), []);
  assert.equal(exactVersionProblems('package.json', { devDependencies: { eslint: '^10.13.0', prettier: '~3.0.0', vite: 'latest' } }).length, 3);
});

test('the application version agrees with the root lockfile', () => {
  const apps = [{ dir: 'demoApp', name: 'tx-demoapp', version: '1.0.1' }];
  assert.deepEqual(lockfileProblems(apps, { packages: { 'apps/demoApp': { name: 'tx-demoapp', version: '1.0.1' } } }), []);
  assert.match(lockfileProblems(apps, { packages: { 'apps/demoApp': { name: 'tx-demoapp', version: '1.0.0' } } }).join(''), /npm version/);
  assert.match(lockfileProblems(apps, { packages: {} }).join(''), /нет записи/);
  const current = readJson(join(root, 'package-lock.json'));
  assert.ok(current.packages['apps/reHistory']);
});

test('repository structure rejects lowercase rule files, dist, extra lockfiles, and shell scripts', () => {
  assert.deepEqual(structureProblems(['AGENTS.md', 'package-lock.json', 'apps/demoApp/src/cli.ts', '.agents/skills/vendor/run.sh', '.agents/skills/vendor/CLAUDE.md']), []);
  const problems = structureProblems([
    'agents.md',
    'docs/AGENTS.md',
    'apps/demoApp/dist/src/cli.js',
    'apps/demoApp/package-lock.json',
    'apps/demoApp/yarn.lock',
    'scripts/run.sh',
    'apps/demoApp/Skill.md'
  ]);
  assert.equal(problems.length, 7);
});

test('a skill adapter keeps the shared name and description', (t) => {
  const base = temporary(t, 'toolchain-config-skills-');
  const write = (path, text) => {
    mkdirSync(join(base, path, '..'), { recursive: true });
    writeFileSync(join(base, path), text);
  };
  write('.agents/skills/demo/SKILL.md', '---\nname: demo\ndescription: Shared text.\n---\nBody\n');
  write('.claude/skills/demo/SKILL.md', '---\nname: demo\ndescription: Shared text.\n---\nAdapter\n');
  assert.deepEqual(adapterProblems(base), []);
  write('.claude/skills/demo/SKILL.md', '---\nname: demo\ndescription: Other text.\n---\nAdapter\n');
  write('.codex/skills/missing/SKILL.md', '---\nname: missing\ndescription: Text.\n---\n');
  assert.equal(adapterProblems(base).length, 2);
  assert.deepEqual(frontmatter('---\nname: x\ndescription: y: z\n---\n'), { name: 'x', description: 'y: z' });
});

const sha = 'a'.repeat(40);
const goodWorkflow = `name: Demo
on:
  pull_request:
permissions:
  contents: read
jobs:
  demo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${sha} # v7.0.1
        with:
          persist-credentials: false
      - name: Setup
        uses: actions/setup-node@${sha} # v7.1.0
      - uses: ./.github/workflows/local.yml
      - name: Run
        env:
          APP: \${{ inputs.app }}
        run: |
          echo "$APP"
      - run: npm test
`;

test('workflows pin actions, drop checkout credentials, and keep expressions out of run', () => {
  assert.deepEqual(workflowRuleProblems('demo.yml', goodWorkflow), []);
  const bad = goodWorkflow
    .replace('permissions:\n  contents: read\n', '')
    .replace('  pull_request:\n', '  pull_request_target:\n')
    .replace(`actions/setup-node@${sha} # v7.1.0`, 'actions/setup-node@v7')
    .replace('          persist-credentials: false\n', '          fetch-depth: 0\n')
    .replace('echo "$APP"', 'echo "${{ inputs.app }}"')
    .replace('- run: npm test', '- run: echo ${{ github.event.pull_request.title }}');
  const problems = workflowRuleProblems('demo.yml', bad).join('\n');
  for (const pattern of [/permissions/, /pull_request_target/, /полным SHA/, /persist-credentials/, /run/]) assert.match(problems, pattern);
  assert.equal(workflowRuleProblems('demo.yml', bad).filter((problem) => problem.includes('run.')).length, 2);
  assert.match(workflowRuleProblems('demo.yml', goodWorkflow.replace(' # v7.1.0', '')).join(''), /комментарий с версией/);
});

test('workflows reject events that run with secrets for pull request or comment text', () => {
  for (const event of ['workflow_run', 'issue_comment', 'pull_request_review', 'pull_request_review_comment']) {
    assert.match(workflowRuleProblems('demo.yml', goodWorkflow.replace('  pull_request:\n', `  ${event}:\n`)).join('\n'), new RegExp(`событие ${event} запрещено`));
  }
  assert.match(workflowRuleProblems('demo.yml', goodWorkflow.replace(/^on:\n/m, 'on: [push, workflow_run]\n')).join('\n'), /событие workflow_run запрещено/);
});

test('a third-party skill must match the provenance manifest and the tool allowlist', (t) => {
  const base = temporary(t, 'toolchain-config-provenance-');
  const write = (path, text) => {
    mkdirSync(join(base, path, '..'), { recursive: true });
    writeFileSync(join(base, path), text);
  };
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  const skill = '---\nname: vendor\ndescription: Text.\nallowed-tools: Read Grep Glob\n---\nBody\n';
  write('.agents/skills/vendor/SKILL.md', skill);
  write('.agents/skills/local/SKILL.md', '---\nname: local\ndescription: Text.\n---\n');
  write('docs/skill-provenance.json', JSON.stringify({ skills: { vendor: { files: [{ path: 'SKILL.md', sha256: sha(skill) }] } } }));
  mkdirSync(join(base, '.claude', 'skills'), { recursive: true });
  symlinkSync('../../.agents/skills/vendor', join(base, '.claude', 'skills', 'vendor'));
  assert.deepEqual(skillProblems(base), ['.agents/skills/local: навыка нет в docs/skill-provenance.json.']);

  const changed = skill.replace('Read Grep Glob', 'Read Grep Glob Bash').replace('Body', 'Body !`id`');
  write('.agents/skills/vendor/SKILL.md', changed.replace('---\nBody', 'hooks:\n---\nBody'));
  write('.agents/skills/vendor/run.py', 'print(1)\n');
  symlinkSync('../../../outside', join(base, '.claude', 'skills', 'other'));
  const problems = skillProblems(base).join('\n');
  for (const pattern of [/hooks/, /allowed-tools.*Bash/, /!`/, /SHA-256/, /run\.py: файла нет/, /\.claude\/skills\/other/]) assert.match(problems, pattern);
});

test('.nvmrc must contain an exact Node.js version', () => {
  assert.deepEqual(nvmrcProblems('26.12.1\n'), []);
  for (const text of ['26\n', '26.12\n', 'lts/*\n', 'v26.12.1\n', undefined]) assert.equal(nvmrcProblems(text).length, 1);
});

test('the configuration check reads a copied repository', async (t) => {
  const base = temporary(t, 'toolchain-config-repo-');
  for (const path of ['.nvmrc', 'package.json', 'package-lock.json', 'configs', 'apps', '.github', '.agents', '.claude', 'docs']) {
    cpSync(join(root, path), join(base, path), { recursive: true, verbatimSymlinks: true, filter: (source) => !/[\\/](node_modules|dist)([\\/]|$)/.test(source) });
  }
  // The copied Vite configurations import the installed development dependencies.
  symlinkSync(join(root, 'node_modules'), join(base, 'node_modules'), 'junction');
  const files = ['package.json', 'package-lock.json'];
  assert.deepEqual(await configProblems(base, files), []);
  const tsconfig = join(base, 'configs', 'tsconfig.base.json');
  writeFileSync(tsconfig, readFileSync(tsconfig, 'utf8').replace('"strict": true', '"strict": false'));
  assert.match((await configProblems(base, files)).join('\n'), /strict/);
});
