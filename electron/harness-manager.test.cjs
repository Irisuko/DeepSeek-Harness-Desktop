'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

// Exercise lifecycle races using a fake process boundary. No model calls,
// shell commands, or real process termination occur in this test file.
function fixture({ announce = true, crash = false } = {}) {
  const children = [];
  const killed = [];
  const source = fs.readFileSync(path.join(__dirname, 'harness-manager.cjs'), 'utf8');
  const moduleObject = { exports: {} };
  const fakeFs = {
    existsSync: () => true,
    readFileSync: () => JSON.stringify({ version: '0.2.0-rc.2' }),
    mkdirSync() {},
    statSync: () => ({ isDirectory: () => true }),
    realpathSync: value => path.resolve(value),
  };
  const fakeProcess = {
    platform: 'win32', env: { SystemRoot: 'C:\\Windows', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1' },
  };
  const fakeChildProcess = {
    spawn(executable, args, options) {
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.equal(options.env.NODE_OPTIONS, undefined);
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, undefined);
      assert.deepEqual(args.slice(1), ['web', '--host', '127.0.0.1', '--port', '0', '--no-open']);
      const child = new EventEmitter();
      child.pid = 700 + children.length;
      child.exitCode = null;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.close = (code) => { child.exitCode = code; child.emit('close', code, null); };
      child.kill = () => child.close(0);
      children.push(child);
      queueMicrotask(() => {
        if (crash) {
          child.stderr.write('api_key=sk-example-secret https://127.0.0.1:1234/?token=hidden\n');
          child.close(1);
        } else if (announce) {
          child.stdout.write(`dsh web: http://127.0.0.1:${32000 + children.length}/?tok`);
          child.stdout.write('en=fixture-login-secret\n');
        }
      });
      return child;
    },
    execFile(executable, args, options, callback) {
      assert.ok(executable.endsWith('taskkill.exe'));
      assert.equal(options.windowsHide, true);
      assert.deepEqual([args[0], args[2], args[3]], ['/PID', '/T', '/F']);
      const child = children.find(value => value.pid === Number(args[1]));
      assert.ok(child, 'Only a child created by this manager can be terminated');
      killed.push(child.pid);
      child.close(0);
      callback(null, '', '');
    },
  };
  const injectedRequire = name => name === 'node:child_process' ? fakeChildProcess : name === 'node:fs' ? fakeFs : require(name);
  new Function('require', 'module', 'process', source)(injectedRequire, moduleObject, fakeProcess);
  const statuses = [];
  const manager = moduleObject.exports.createHarnessManager({
    runtimeRoot: path.resolve(__dirname, '../runtime'), dataDir: path.resolve(__dirname, '../fixture-home'),
    onStatus: value => statuses.push(value),
  });
  return { manager, children, killed, statuses };
}

test('authenticates from a split readiness line, reuses the process, and stops its owned tree', async () => {
  const { manager, children, killed, statuses } = fixture();
  const workspace = path.resolve(__dirname, '..');
  const first = await manager.start({ workspace });
  assert.match(first.url, /token=fixture-login-secret/);
  assert.equal((await manager.start({ workspace })).url, first.url);
  assert.equal(children.length, 1);
  assert.equal(JSON.stringify(statuses).includes('fixture-login-secret'), false);
  await manager.stop();
  assert.deepEqual(killed, [children[0].pid]);
  assert.equal(manager.getStatus().state, 'stopped');
});

test('reports startup failure without leaking URL tokens or API keys', async () => {
  const { manager, statuses } = fixture({ crash: true });
  await assert.rejects(manager.start({ workspace: path.resolve(__dirname) }), /启动失败/);
  const diagnostic = JSON.stringify(statuses);
  assert.equal(diagnostic.includes('sk-example-secret'), false);
  assert.equal(diagnostic.includes('token=hidden'), false);
  assert.equal(manager.getStatus().state, 'error');
});

test('stopping a startup rejects readiness and does not later publish running', async () => {
  const { manager, statuses } = fixture({ announce: false });
  const pending = manager.start({ workspace: path.resolve(__dirname) });
  const rejected = assert.rejects(pending, /已取消/);
  await manager.stop();
  await rejected;
  assert.equal(manager.getStatus().state, 'stopped');
  assert.equal(statuses.some(value => value.state === 'running'), false);
});

test('switching workspaces stops the old process before the replacement starts', async () => {
  const { manager, children, killed } = fixture();
  await manager.start({ workspace: path.resolve(__dirname) });
  await manager.start({ workspace: path.resolve(__dirname, '..') });
  assert.deepEqual(killed, [children[0].pid]);
  assert.equal(children.length, 2);
  assert.equal(manager.getStatus().workspace, path.resolve(__dirname, '..'));
  await manager.stop();
  assert.deepEqual(killed, children.map(value => value.pid));
});
