import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkPandocVersion, findTool, parsePandocVersion, parseWriters, toolEnvironment } from '@reBook/tools';
import { expect, test, type TestContext } from 'vitest';

function workspace(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'tx-rebook-tools-test-'));
  t.onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('the tool environment drops variables that load code or change data directories', () => {
  const env = toolEnvironment(
    '/opt/tools/pandoc',
    {
      HOME: '/home/user',
      LANG: 'ru_RU.UTF-8',
      SOURCE_DATE_EPOCH: '1',
      PATH: '/evil:/usr/bin',
      LUA_PATH: '/evil/?.lua',
      LUA_CPATH: '/evil/?.so',
      LUA_INIT: 'os.exit()',
      JAVA_TOOL_OPTIONS: '-javaagent:/evil.jar',
      _JAVA_OPTIONS: '-javaagent:/evil.jar',
      XDG_DATA_HOME: '/evil',
      PANDOC_DATA_DIR: '/evil'
    },
    'darwin'
  );
  expect(env).toEqual({ HOME: '/home/user', LANG: 'ru_RU.UTF-8', SOURCE_DATE_EPOCH: '1', PATH: '/opt/tools:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin' });
});

test('Windows variable names do not depend on letter case', () => {
  const env = toolEnvironment('C:\\Tools\\pandoc.exe', { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', lua_path: 'x', Java_Tool_Options: 'y' }, 'win32');
  expect(env).toEqual({ PATH: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows' });
});

test('tool search uses only absolute PATH entries and executable files', (t) => {
  if (process.platform === 'win32') return;
  const directory = workspace(t);
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const tool = join(bin, 'pandoc');
  writeFileSync(tool, '#!/bin/sh\n');
  chmodSync(tool, 0o644);
  expect(findTool('pandoc', `${bin}`, 'linux')).toBeUndefined();
  chmodSync(tool, 0o755);
  expect(findTool('pandoc', `relative:${bin}`, 'linux')).toBe(tool);
  expect(findTool('pandoc', 'relative:.', 'linux')).toBeUndefined();
});

test('Pandoc versions before 3.0 are rejected', () => {
  expect(parsePandocVersion('pandoc 3.1.3\nFeatures: +lua')).toEqual([3, 1]);
  expect(parsePandocVersion('pandoc.exe 3.6')).toEqual([3, 6]);
  expect(parsePandocVersion('something else')).toBeUndefined();
  expect(() => {
    checkPandocVersion([2, 19]);
  }).toThrow(/Pandoc 3\.0 или новее/);
  expect(() => {
    checkPandocVersion(undefined);
  }).toThrow(/версию Pandoc/);
  checkPandocVersion([3, 0]);
  expect(parseWriters('docx\nepub3\n\x1b[31mbad\nhtml5\r\n')).toEqual(['docx', 'epub3', 'html5']);
});
