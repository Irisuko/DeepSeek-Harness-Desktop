'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function fixture({ expectedVersion = '0.1.6-alpha.2', manifestVersion = expectedVersion, announce = true, nodePath, prepareLaunch, crashWith } = {}) {
  const source = fs.readFileSync(path.join(__dirname, 'harness-manager.cjs'), 'utf8');
  const moduleObject = { exports: {} };
  const runtimeRoot = path.resolve('fixture-updates/runtime-candidate');
  const sharedNode = nodePath || path.resolve('fixture-bundle/node.exe');
  const cliPath = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const dataDir = path.resolve('fixture-data');
  const spawned = [];
  const existsChecks = [];
  const fakeFs = {
    existsSync(value) { existsChecks.push(value); return value === sharedNode || value === cliPath; },
    readFileSync: () => JSON.stringify({ name: '@deepseek-ai/dsh', version: manifestVersion }),
    mkdirSync() {},
    statSync: () => ({ isDirectory: () => true }),
    realpathSync: value => path.resolve(value),
  };
  const fakeChildProcess = {
    spawn(executable, args, options) {
      const child = new EventEmitter();
      child.pid = 800 + spawned.length;
      child.exitCode = null;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.close = code => { child.exitCode = code; child.emit('close', code, null); };
      child.kill = () => child.close(0);
      spawned.push({ executable, args, options, child });
      if (crashWith) queueMicrotask(() => { child.stderr.write(crashWith + '\n'); child.close(1); });
      else if (announce) queueMicrotask(() => child.stdout.write('dsh web: http://127.0.0.1:32123/?token=fixture-runtime\n'));
      return child;
    },
    execFile(executable, args, options, callback) {
      assert.ok(executable.endsWith('taskkill.exe'));
      assert.equal(options.windowsHide, true);
      const owned = spawned.find(record => record.child.pid === Number(args[1]));
      assert.ok(owned);
      owned.child.close(0);
      callback(null, '', '');
    },
  };
  const injectedRequire = name => name === 'node:fs' ? fakeFs : name === 'node:child_process' ? fakeChildProcess : require(name);
  const fakeProcess = { platform: 'win32', env: { SystemRoot: 'C:\\Windows', NODE_OPTIONS: '--inspect', NODE_PATH: 'other', ELECTRON_RUN_AS_NODE: '1', DS_DESKTOP_REMOVED_API_KEY: 'stale-key' } };
  new Function('require', 'module', 'process', source)(injectedRequire, moduleObject, fakeProcess);
  const manager = moduleObject.exports.createHarnessManager({ runtimeRoot, dataDir, nodePath: sharedNode, expectedVersion, prepareLaunch });
  return { manager, runtimeRoot, sharedNode, cliPath, dataDir, spawned, existsChecks };
}

test('updated runtime uses the bundled external Node and its own exact CLI version', async () => {
  const f = fixture();
  assert.equal(f.manager.isActive(), false);
  assert.equal(f.manager.getStatus().version, '0.1.6-alpha.2');
  const starting = f.manager.start({ workspace: path.resolve('fixture-workspace') });
  assert.equal(f.manager.isActive(), true);
  await starting;
  assert.equal(f.manager.isActive(), true);
  assert.equal(f.spawned.length, 1);
  assert.equal(f.spawned[0].executable, f.sharedNode);
  assert.equal(f.spawned[0].args[0], f.cliPath);
  assert.equal(f.spawned[0].options.env.DSH_HOME, path.join(f.dataDir, 'harness-home'));
  assert.equal(f.spawned[0].options.env.NODE_OPTIONS, undefined);
  assert.equal(f.spawned[0].options.env.NODE_PATH, undefined);
  assert.equal(f.spawned[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(f.existsChecks.includes(path.join(f.runtimeRoot, 'node.exe')), false);
  await f.manager.stop();
  assert.equal(f.manager.isActive(), false);
});

test('candidate manifest mismatch fails before spawning a process', async () => {
  const f = fixture({ manifestVersion: '0.1.5-rc.1' });
  await assert.rejects(f.manager.start({ workspace: path.resolve('fixture-workspace') }), /校验失败/);
  assert.equal(f.spawned.length, 0);
  assert.equal(f.manager.isActive(), false);
  assert.equal(f.manager.getStatus().state, 'error');
});

test('activity flag covers a starting child and clears after cancellation', async () => {
  const f = fixture({ announce: false });
  const pending = f.manager.start({ workspace: path.resolve('fixture-workspace') });
  const rejected = assert.rejects(pending, /已取消/);
  assert.equal(f.manager.isActive(), true);
  await f.manager.stop();
  await rejected;
  assert.equal(f.manager.isActive(), false);
});

test('unexpected child exit clears activity so recovery can be offered', async () => {
  const f = fixture();
  await f.manager.start({ workspace: path.resolve('fixture-workspace') });
  f.spawned[0].child.close(1);
  assert.equal(f.manager.isActive(), false);
  assert.equal(f.manager.getStatus().state, 'error');
});

test('relative external Node paths and invalid version specs are rejected', () => {
  assert.throws(() => fixture({ nodePath: 'node.exe' }), /配置无效/);
  assert.throws(() => fixture({ expectedVersion: 'latest' }), /配置无效/);
});

test('valid build metadata in an exact upstream version is accepted', async () => {
  const f = fixture({ expectedVersion: '0.1.6-alpha.2+build.1' });
  await f.manager.start({ workspace: path.resolve('fixture-workspace') });
  assert.equal(f.manager.getStatus().version, '0.1.6-alpha.2+build.1');
  await f.manager.stop();
});

test('shared launch snapshot reaches only the child and is reused until explicit restart', async () => {
  let calls = 0;
  const patch = path.resolve('fixture-data/desktop-connections.patch.json');
  const f = fixture({ prepareLaunch: () => ({ args: ['--patch', patch], env: { DS_DESKTOP_ZEN_API_KEY: `fixture-key-${++calls}` } }) });
  const workspace = path.resolve('fixture-workspace');
  await f.manager.start({ workspace });
  assert.deepEqual(f.spawned[0].args.slice(1), ['web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open']);
  assert.equal(f.spawned[0].options.env.DS_DESKTOP_ZEN_API_KEY, 'fixture-key-1');
  assert.equal(f.spawned[0].options.env.DS_DESKTOP_REMOVED_API_KEY, undefined);
  await f.manager.start({ workspace });
  assert.equal(calls, 1);
  await f.manager.stop();
  await f.manager.start({ workspace });
  assert.equal(f.spawned[1].options.env.DS_DESKTOP_ZEN_API_KEY, 'fixture-key-2');
  await f.manager.stop();
});

test('stop during shared connection preparation prevents a late launch and blocks runtime updates', async () => {
  let release;
  const f = fixture({ prepareLaunch: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.manager.start({ workspace: path.resolve('fixture-workspace') });
  const rejected = assert.rejects(pending, /已取消/);
  assert.equal(f.manager.isActive(), true);
  assert.equal(f.manager.getStatus().state, 'starting');
  await Promise.resolve();
  const stopping = f.manager.stop();
  release({ env: {}, args: [] });
  await Promise.all([stopping, rejected]);
  assert.equal(f.spawned.length, 0);
  assert.equal(f.manager.isActive(), false);
  assert.equal(f.manager.getStatus().state, 'stopped');
});

test('shared opaque API keys are redacted in actual child failure diagnostics', async () => {
  const f = fixture({ prepareLaunch: () => ({ env: { DS_DESKTOP_ZEN_API_KEY: 'opaque-credential-123' } }), crashWith: 'failure opaque-credential-123' });
  await assert.rejects(f.manager.start({ workspace: path.resolve('fixture-workspace') }), error => {
    assert.ok(!error.message.includes('opaque-credential-123'));
    return /启动失败/.test(error.message);
  });
  assert.ok(!JSON.stringify(f.manager.getStatus()).includes('opaque-credential-123'));
});
