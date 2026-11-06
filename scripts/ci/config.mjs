// Check repository settings that the documentation requires: TypeScript, aliases, package metadata,
// dependencies, the lockfile, repository structure, and GitHub Actions workflows.
// Usage: node scripts/ci/config.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readRegularFile } from './files.mjs';
import { listApps, main, readJson, root, safe } from './lib.mjs';

// Compiler options that each application inherits from configs/tsconfig.base.json.
export const requiredCompilerOptions = {
  strict: true,
  noEmitOnError: true,
  forceConsistentCasingInFileNames: true,
  module: 'ESNext',
  moduleResolution: 'Bundler',
  verbatimModuleSyntax: true,
  isolatedModules: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  noImplicitOverride: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true
};
// Application tsconfig files set only local paths. Other compiler options come from the shared base.
const localCompilerOptions = new Set(['rootDir', 'outDir', 'paths']);
const requiredScripts = ['build', 'typecheck', 'test', 'start', 'prepack'];
const installHooks = ['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare'];
const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];
const exactVersion = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const unpublishedDirectory = /^(\.\/)?(src|test|scripts|node_modules|coverage|reports)(\/|$)/;
const wildcard = /[*?[\]{}!]/;
const ruleFileNames = new Set(['agents.md', 'skill.md', 'claude.md', 'gemini.md']);
const lockfiles = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock']);
const vendoredSkills = /^\.(agents|claude|codex|gemini)\/skills\//;
const fullSha = /^[^\s@]+@[0-9a-f]{40}$/;
// Shell scripts that are permitted. Use TypeScript or Node.js unless a documented reason requires Bash.
export const shellScriptAllowlist = [];
// Runtime dependencies that a human approved for each application package. Add an entry only after a dependency review.
export const runtimeDependencyAllowlist = {};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Base TypeScript configuration: required options must be present with the documented values.
export function baseTsconfigProblems(config) {
  const options = isObject(config?.compilerOptions) ? config.compilerOptions : {};
  return Object.entries(requiredCompilerOptions)
    .filter(([key, value]) => options[key] !== value)
    .map(([key, value]) => `configs/tsconfig.base.json: compilerOptions.${key} должен быть ${JSON.stringify(value)}.`);
}

// Application TypeScript configuration: local paths only, one application alias, and an optional @shared alias.
export function appTsconfigProblems(dir, config) {
  const file = `apps/${dir}/tsconfig.json`;
  const problems = [];
  const options = isObject(config?.compilerOptions) ? config.compilerOptions : {};
  if (config?.extends !== '../../configs/tsconfig.base.json') problems.push(`${file}: extends должен указывать на ../../configs/tsconfig.base.json.`);
  for (const key of Object.keys(options)) if (!localCompilerOptions.has(key)) problems.push(`${file}: compilerOptions.${key} задаётся только в configs/tsconfig.base.json.`);
  if (options.rootDir !== '.') problems.push(`${file}: rootDir должен быть ".".`);
  if (options.outDir !== 'dist') problems.push(`${file}: outDir должен быть "dist".`);
  const paths = isObject(options.paths) ? options.paths : {};
  for (const [key, value] of Object.entries(paths)) {
    if (key === `@${dir}/*`) {
      if (!same(value, ['./src/*.ts'])) problems.push(`${file}: paths["@${dir}/*"] должен быть ["./src/*.ts"].`);
    } else if (key === '@shared/*') {
      if (!Array.isArray(value) || value.length === 0 || !value.every((target) => typeof target === 'string' && target.startsWith('../../shared/'))) {
        problems.push(`${file}: paths["@shared/*"] должен указывать в ../../shared/.`);
      }
    } else {
      problems.push(`${file}: недопустимый alias ${safe(key)}. Разрешены только @${dir}/* и @shared/*.`);
    }
  }
  if (!(`@${dir}/*` in paths)) problems.push(`${file}: нет alias @${dir}/*.`);
  if (!Array.isArray(config?.include) || !config.include.includes('src/**/*.ts')) problems.push(`${file}: include должен содержать src/**/*.ts.`);
  for (const excluded of ['dist', 'node_modules']) {
    if (!Array.isArray(config?.exclude) || !config.exclude.includes(excluded)) problems.push(`${file}: exclude должен содержать ${excluded}.`);
  }
  return problems;
}

// Vite and Vitest must resolve the same application alias to the application source directory.
export function aliasProblems(dir, appRoot, viteAlias, vitestAlias) {
  const expected = { [`@${dir}`]: resolve(appRoot, 'src') };
  const problems = [];
  for (const [name, alias] of [
    ['vite.config.mjs', viteAlias],
    ['vitest.config.mjs', vitestAlias]
  ]) {
    const actual = isObject(alias) ? Object.fromEntries(Object.entries(alias).filter(([key]) => key !== '@shared')) : alias;
    if (!same(actual, expected)) problems.push(`apps/${dir}/${name}: resolve.alias должен содержать только @${dir} → src (и при необходимости @shared).`);
  }
  return problems;
}

// Application package metadata from docs/PACKAGES.md.
export function manifestProblems(dir, manifest, rootManifest, exists = () => true) {
  const file = `apps/${dir}/package.json`;
  const problems = [];
  if (typeof manifest.description !== 'string' || manifest.description.trim() === '') problems.push(`${file}: нет description.`);
  if (typeof manifest.license !== 'string' || manifest.license.trim() === '') problems.push(`${file}: нет license.`);
  if (manifest.type !== 'module') problems.push(`${file}: type должен быть "module".`);
  if (manifest.engines?.node !== rootManifest.engines?.node) problems.push(`${file}: engines.node должен совпадать с корневым package.json (${safe(rootManifest.engines?.node)}).`);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    problems.push(`${file}: нужен узкий список files.`);
  } else {
    for (const entry of manifest.files) {
      if (typeof entry !== 'string' || wildcard.test(entry) || unpublishedDirectory.test(entry) || ['.', './', 'dist', 'dist/'].includes(entry)) {
        problems.push(`${file}: недопустимая запись files ${safe(entry)}. Перечислите отдельные публикуемые файлы.`);
      }
    }
    for (const required of ['README.md', 'LICENSE']) if (!manifest.files.includes(required)) problems.push(`${file}: files должен содержать ${required}.`);
  }
  for (const required of ['README.md', 'LICENSE']) if (!exists(required)) problems.push(`apps/${dir}: нет файла ${required}.`);
  if (!isObject(manifest.exports)) problems.push(`${file}: exports должен быть объектом. Для CLI без API используйте {}.`);
  else if (!('types' in manifest) && Object.keys(manifest.exports).length > 0) problems.push(`${file}: exports должен быть {}, если пакет не объявляет types.`);
  if (manifest.repository?.type !== 'git' || manifest.repository?.directory !== `apps/${dir}`) problems.push(`${file}: repository должен иметь type "git" и directory "apps/${dir}".`);
  const scripts = isObject(manifest.scripts) ? manifest.scripts : {};
  for (const name of requiredScripts) if (typeof scripts[name] !== 'string') problems.push(`${file}: нет скрипта ${name}.`);
  for (const name of installHooks) if (name in scripts) problems.push(`${file}: скрипт ${name} запрещён. Не используйте хуки установки.`);
  if (typeof scripts.prepack === 'string' && !/\bnpm run build\b/.test(scripts.prepack)) problems.push(`${file}: prepack должен запускать npm run build.`);
  const targets = isObject(manifest.bin) ? [...new Set(Object.values(manifest.bin))] : [];
  if (targets.length !== 1) {
    problems.push(`${file}: bin должен указывать на одну точку входа.`);
  } else {
    const [target] = targets;
    const start = typeof scripts.start === 'string' ? scripts.start : '';
    if (!start.split('&&').some((part) => part.trim() === `node ${target}`)) problems.push(`${file}: start должен запускать node ${safe(target)}, как bin.`);
    const sourceEntry = posix
      .normalize(String(target))
      .replace(/^dist\//, '')
      .replace(/\.js$/, '.ts');
    if (!exists(sourceEntry)) problems.push(`${file}: нет исходного файла ${safe(sourceEntry)} для bin.`);
    else if (!exists(sourceEntry, '#!/usr/bin/env node\n')) problems.push(`apps/${dir}/${safe(sourceEntry)}: точка входа должна начинаться с #!/usr/bin/env node.`);
  }
  for (const field of dependencyFields) {
    const value = manifest[field];
    if (value === undefined) continue;
    const names = Array.isArray(value) ? value : isObject(value) ? Object.keys(value) : [];
    const allowed = runtimeDependencyAllowlist[manifest.name] ?? [];
    for (const name of names) if (!allowed.includes(name)) problems.push(`${file}: ${field}.${safe(name)} нет в списке разрешённых runtime-зависимостей scripts/ci/config.mjs.`);
  }
  if (manifest.devDependencies !== undefined) problems.push(`${file}: devDependencies храните в корневом package.json.`);
  return problems;
}

// Development dependencies must use exact versions, because save-exact applies only to new installs.
export function exactVersionProblems(file, manifest) {
  return Object.entries(isObject(manifest.devDependencies) ? manifest.devDependencies : {})
    .filter(([, value]) => typeof value !== 'string' || !exactVersion.test(value))
    .map(([name, value]) => `${file}: devDependencies.${safe(name)} должен иметь точную версию, а не ${safe(value)}.`);
}

// The application version must agree with the root lockfile. A difference shows a manual version edit.
export function lockfileProblems(apps, lockfile) {
  const problems = [];
  for (const app of apps) {
    const entry = lockfile?.packages?.[`apps/${app.dir}`];
    if (!entry) problems.push(`package-lock.json: нет записи apps/${app.dir}.`);
    else if (entry.version !== app.version || entry.name !== app.name) {
      problems.push(`package-lock.json: apps/${app.dir} должен иметь ${app.name}@${app.version}. Меняйте версию только через npm version.`);
    }
  }
  return problems;
}

// Repository structure: rule file names, generated output, lockfiles, and shell scripts. `files` are tracked paths.
export function structureProblems(files) {
  const problems = [];
  for (const path of files) {
    const parts = path.split('/');
    const name = parts.at(-1) ?? '';
    if (ruleFileNames.has(name.toLowerCase()) && name !== name.toUpperCase().replace(/\.MD$/, '.md'))
      problems.push(`${safe(path)}: используйте имя ${safe(name.toUpperCase().replace(/\.MD$/, '.md'))}.`);
    if (['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].includes(name) && parts.length > 1 && !vendoredSkills.test(path))
      problems.push(`${safe(path)}: файл правил агентов допустим только в корне репозитория.`);
    if (parts.includes('dist')) problems.push(`${safe(path)}: сгенерированный dist/ не хранится в Git.`);
    if (lockfiles.has(name) && path !== 'package-lock.json') problems.push(`${safe(path)}: используйте только корневой package-lock.json.`);
    if (/\.(sh|bash|zsh)$/.test(name) && !vendoredSkills.test(path) && !shellScriptAllowlist.includes(path)) {
      problems.push(`${safe(path)}: скрипт Bash не входит в разрешённый список. Используйте Node.js или обоснуйте исключение.`);
    }
  }
  return problems;
}

// Frontmatter value of a SKILL.md file. Only simple one-line values are read.
export function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  const result = {};
  for (const line of (match?.[1] ?? '').split(/\r?\n/)) {
    const field = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (field?.[1] && field[2] !== undefined) result[field[1]] = field[2].trim();
  }
  return result;
}

// A vendor skill adapter must keep the name and description of the shared skill in .agents/skills.
export function adapterProblems(base = root) {
  const problems = [];
  for (const vendor of ['.claude', '.codex', '.gemini']) {
    const directory = join(base, vendor, 'skills');
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const adapter = join(directory, entry.name, 'SKILL.md');
      const shared = join(base, '.agents', 'skills', entry.name, 'SKILL.md');
      const adapterText = readRegularFile(adapter);
      if (adapterText === undefined) continue;
      const sharedText = readRegularFile(shared);
      if (sharedText === undefined) {
        problems.push(`${vendor}/skills/${safe(entry.name)}: нет общего навыка .agents/skills/${safe(entry.name)}/SKILL.md.`);
        continue;
      }
      const left = frontmatter(adapterText);
      const right = frontmatter(sharedText);
      if (left.name !== right.name || left.description !== right.description) {
        problems.push(`${vendor}/skills/${safe(entry.name)}/SKILL.md: name и description должны совпадать с .agents/skills/${safe(entry.name)}/SKILL.md.`);
      }
    }
  }
  return problems;
}

const indentOf = (line) => line.length - line.trimStart().length;

// GitHub Actions rules from AGENTS.md. The parser reads the line structure of the workflow files in this repository.
export function workflowRuleProblems(file, text) {
  const lines = text.split(/\r?\n/);
  const problems = [];
  if (!lines.some((line) => /^permissions:/.test(line))) problems.push(`${file}: нет permissions на верхнем уровне.`);
  if (lines.some((line) => /^\s*pull_request_target\s*:/.test(line) || /^on:.*\bpull_request_target\b/.test(line))) problems.push(`${file}: событие pull_request_target запрещено.`);
  lines.forEach((line, index) => {
    const number = index + 1;
    const uses = /^(\s*)(- )?uses:\s*(\S+)(\s+#\s*(\S+))?\s*$/.exec(line);
    if (uses) {
      const [, spaces = '', dash, target = '', , comment] = uses;
      if (!target.startsWith('./')) {
        if (!fullSha.test(target)) problems.push(`${file}:${number}: action должен быть закреплён полным SHA коммита.`);
        else if (!comment || !/^v\d/.test(comment)) problems.push(`${file}:${number}: после SHA нужен комментарий с версией, например # v1.2.3.`);
      }
      if (/^actions\/checkout@/.test(target)) {
        const stepIndent = dash ? spaces.length : findStepIndent(lines, index, spaces.length);
        const end = lines.findIndex((next, position) => position > index && next.trim() !== '' && indentOf(next) <= stepIndent);
        const step = lines.slice(index + 1, end < 0 ? lines.length : end);
        if (!step.some((next) => /^\s*persist-credentials:\s*false\s*$/.test(next))) problems.push(`${file}:${number}: checkout должен иметь persist-credentials: false.`);
      }
    }
    const run = /^(\s*)(- )?run:\s*(.*)$/.exec(line);
    if (run) {
      const [, spaces = '', dash, value = ''] = run;
      const keyIndent = spaces.length + (dash ? 2 : 0);
      let body = [value];
      if (/^[|>]/.test(value)) {
        const end = lines.findIndex((next, position) => position > index && next.trim() !== '' && indentOf(next) <= keyIndent);
        body = lines.slice(index + 1, end < 0 ? lines.length : end);
      }
      if (body.some((part) => part.includes('${{'))) problems.push(`${file}:${number}: не вставляйте выражения \${{ }} в run. Передайте значение через env.`);
    }
  });
  return problems;
}

function findStepIndent(lines, index, keyIndent) {
  for (let position = index - 1; position >= 0; position--) {
    const line = lines[position] ?? '';
    if (line.trim() === '') continue;
    const step = /^(\s*)- /.exec(line);
    if (step?.[1] !== undefined && step[1].length < keyIndent) return step[1].length;
  }
  return keyIndent;
}

function trackedFiles(base) {
  // Inherited GIT_* variables could select another repository or index.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  const result = spawnSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false', 'ls-files', '-z'], {
    cwd: base,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000
  });
  if (result.error || result.status !== 0) throw new Error('Не удалось получить список файлов из git ls-files.');
  return result.stdout.split('\0').filter(Boolean);
}

async function configAlias(path) {
  const config = (await import(pathToFileURL(path).href)).default;
  return config?.resolve?.alias;
}

export async function configProblems(base = root, files = trackedFiles(base)) {
  const problems = [];
  problems.push(...baseTsconfigProblems(readJson(join(base, 'configs', 'tsconfig.base.json'))));
  const rootManifest = readJson(join(base, 'package.json'));
  problems.push(...exactVersionProblems('package.json', rootManifest));
  const apps = listApps(base);
  for (const app of apps) {
    const appRoot = join(base, 'apps', app.dir);
    problems.push(...appTsconfigProblems(app.dir, readJson(join(appRoot, 'tsconfig.json'))));
    problems.push(...aliasProblems(app.dir, appRoot, await configAlias(join(appRoot, 'vite.config.mjs')), await configAlias(join(appRoot, 'vitest.config.mjs'))));
    const exists = (path, prefix) => {
      const full = join(appRoot, path);
      let text;
      try {
        text = readRegularFile(full);
      } catch {
        return false;
      }
      return text !== undefined && (prefix === undefined || text.startsWith(prefix));
    };
    problems.push(...manifestProblems(app.dir, readJson(join(appRoot, 'package.json')), rootManifest, exists));
  }
  problems.push(...lockfileProblems(apps, readJson(join(base, 'package-lock.json'))));
  problems.push(...structureProblems(files));
  problems.push(...adapterProblems(base));
  const workflowDirectory = join(base, '.github', 'workflows');
  for (const name of readdirSync(workflowDirectory)
    .filter((item) => /\.ya?ml$/.test(item))
    .sort()) {
    problems.push(...workflowRuleProblems(`.github/workflows/${name}`, readFileSync(join(workflowDirectory, name), 'utf8')));
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main(async () => {
    const problems = await configProblems();
    if (problems.length) throw new Error(`Настройки репозитория не соответствуют документации:\n${problems.join('\n')}`);
    console.log('Настройки TypeScript, пакетов, структуры и GitHub Actions соответствуют документации.');
  });
}
