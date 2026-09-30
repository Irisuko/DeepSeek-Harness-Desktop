'use strict';

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SUPPORTED_HARNESS_VERSION = '0.2.0-rc.2';
const START_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 6_000;
const MAX_LOG_CHARS = 8_192;

/** Hide process-login tokens and common credential formats before displaying diagnostics. */
function sanitizeOutput(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets) if (secret) text = text.split(secret).join('[credential hidden]');
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
      } catch { return '[URL hidden]'; }
    })
    .replace(/\b(?:sk-[a-z\d_-]+|Bearer\s+[^\s,;]+)/gi, '[credential hidden]')
    .replace(/((?:api[_ -]?key|authorization|token|password)\s*[=:]\s*)[^\s,;]+/gi, '$1[hidden]')
    .slice(-MAX_LOG_CHARS);
}

/** Only accept the ready URL announced by the child bound to the requested loopback host. */
function parseReadyUrl(line) {
  const clean = String(line).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
  const match = /^dsh web:\s+(http:\/\/\S+)/.exec(clean.trim());
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    const port = Number(url.port);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || !Number.isInteger(port) || port < 1 || port > 65535
      || url.username || url.password || url.pathname !== '/' || !url.searchParams.get('token')) return null;
    return url.href;
  } catch { return null; }
}

/** Own one official Harness Web process; the renderer never receives filesystem or spawn access. */
function createHarnessManager({ runtimeRoot, dataDir, nodePath: runtimeNodePath, expectedVersion = SUPPORTED_HARNESS_VERSION, prepareLaunch = null, onStatus = () => {} }) {
  if (!path.isAbsolute(runtimeRoot) || !path.isAbsolute(dataDir)) {
    throw new Error('Harness runtimeRoot 和 dataDir 必须是绝对路径。');
  }
  const nodePath = runtimeNodePath || path.join(runtimeRoot, process.platform === 'win32' ? 'node.exe' : 'node');
  if (!path.isAbsolute(nodePath) || typeof expectedVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(expectedVersion)) throw new Error('Harness 运行时配置无效。');
  const packageRoot = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh');
  const cliPath = path.join(packageRoot, 'lib', 'bin.js');
  const harnessHome = path.join(dataDir, 'harness-home');
  let current = null;
  let preparation = null;
  let revision = 0;
  let status = { state: 'stopped', message: 'Harness 尚未启动', workspace: null, origin: null, version: expectedVersion };

  function publish(patch) {
    status = { ...status, ...patch };
    // Observers cannot break child lifecycle or expose its private startup URL.
    try { onStatus({ ...status }); } catch { /* A closing Electron window can reject delivery. */ }
  }

  function validateRuntime() {
    if (!fs.existsSync(nodePath) || !fs.existsSync(cliPath)) {
      throw new Error('Harness 运行环境不完整，请重新安装桌面应用修复引擎。');
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.version !== expectedVersion) {
      throw new Error('Harness 运行时校验失败，请重新安装桌面应用修复引擎。');
    }
    fs.mkdirSync(harnessHome, { recursive: true });
  }

  function launch(workspace, launchConfig) {
    validateRuntime();
    // The upstream runtime includes native modules. Run it with upstream Node,
    // independently from Electron's embedded Node ABI and renderer environment.
    const env = { ...process.env, DSH_HOME: harnessHome, NO_COLOR: '1', FORCE_COLOR: '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    for (const key of Object.keys(env)) if (key.startsWith('DS_DESKTOP_')) delete env[key];
    Object.assign(env, launchConfig.env);
    const redact = value => sanitizeOutput(value, Object.values(launchConfig.env || {}));
    const child = spawn(nodePath, [cliPath, 'web', ...(launchConfig.args || []), '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd: workspace, env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // A stop request can reject readiness before a caller attaches its own handler.
    ready.catch(() => {});
    const record = { child, workspace, ready, resolveReady, rejectReady, url: null,
      stopping: false, stopPromise: null, exited: false, log: '', timer: null, exitPromise: null };
    record.exitPromise = new Promise((resolve) => child.once('close', resolve));
    current = record;
    publish({ state: 'starting', message: '正在启动本地 Harness…', workspace, origin: null });

    function consume(line, isStdout) {
      if (isStdout && !record.url && !record.stopping) {
        const url = parseReadyUrl(line);
        if (url) {
          record.url = url;
          clearTimeout(record.timer);
          if (current === record) publish({ state: 'running', message: 'Harness 已连接', origin: new URL(url).origin });
          resolveReady({ url });
          return;
        }
      }
      record.log = (record.log + '\n' + redact(line)).slice(-MAX_LOG_CHARS);
    }

    for (const [stream, isStdout] of [[child.stdout, true], [child.stderr, false]]) {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        pending += chunk;
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          consume(pending.slice(0, end), isStdout);
          pending = pending.slice(end + 1);
        }
        // Discard very long diagnostics; never accumulate unlimited process output.
        if (pending.length > MAX_LOG_CHARS) {
          consume(pending.slice(0, MAX_LOG_CHARS), false);
          pending = '';
        }
      });
      stream.on('end', () => { if (pending) consume(pending, isStdout); });
    }

    child.once('error', (error) => {
      clearTimeout(record.timer);
      const message = `Harness 无法启动：${redact(error.message)}`;
      rejectReady(new Error(message));
      if (current === record && !record.stopping) publish({ state: 'error', message, origin: null });
    });
    child.once('close', (code, signal) => {
      record.exited = true;
      clearTimeout(record.timer);
      if (!record.url) rejectReady(new Error(record.stopping ? 'Harness 启动已取消。'
        : `Harness 启动失败（${code ?? signal ?? 'unknown'}）。${record.log.trim() ? '\n' + record.log.trim() : ''}`));
      if (current !== record) return;
      current = null;
      if (record.stopping) publish({ state: 'stopped', message: 'Harness 已停止', origin: null });
      else publish({ state: 'error', message: `Harness 进程已退出（${code ?? signal ?? 'unknown'}）。${record.log.trim() ? '\n' + record.log.trim() : ''}`, origin: null });
    });
    record.timer = setTimeout(() => {
      const message = `Harness 启动超时。${record.log.trim() ? '\n' + record.log.trim() : ''}`;
      rejectReady(new Error(message));
      void stopRecord(record).then(() => {
        if (current === null) publish({ state: 'error', message, origin: null });
      }, (error) => publish({ state: 'error', message: `${message}\n${redact(error.message)}`, origin: null }));
    }, START_TIMEOUT_MS);
    return ready;
  }

  function stopRecord(record) {
    if (record.stopPromise) return record.stopPromise;
    record.stopping = true;
    clearTimeout(record.timer);
    record.rejectReady(new Error('Harness 启动已取消。'));
    if (current === record) publish({ state: 'stopping', message: '正在停止 Harness…', origin: null });
    record.stopPromise = (async () => {
      if (!record.exited && record.child.pid && record.child.exitCode === null) {
        if (process.platform === 'win32') {
          // kill('SIGTERM') on Windows kills only the parent. taskkill targets
          // this manager's still-running child and its descendants, by PID only.
          const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
          await new Promise((resolve) => {
            execFile(taskkill, ['/PID', String(record.child.pid), '/T', '/F'],
              { windowsHide: true, timeout: STOP_TIMEOUT_MS, maxBuffer: 8_192 }, () => resolve());
          });
        } else {
          try { process.kill(-record.child.pid, 'SIGTERM'); } catch (error) {
            if (error.code !== 'ESRCH') record.child.kill('SIGTERM');
          }
        }
        let timer;
        await Promise.race([record.exitPromise, new Promise((resolve) => { timer = setTimeout(resolve, STOP_TIMEOUT_MS); })]);
        clearTimeout(timer);
        if (!record.exited && record.child.exitCode === null) {
          if (process.platform === 'win32') record.child.kill();
          else {
            try { process.kill(-record.child.pid, 'SIGKILL'); } catch (error) {
              if (error.code !== 'ESRCH') record.child.kill('SIGKILL');
            }
          }
          let killTimer;
          await Promise.race([record.exitPromise, new Promise((resolve) => { killTimer = setTimeout(resolve, 1_500); })]);
          clearTimeout(killTimer);
        }
        if (!record.exited && record.child.exitCode === null) {
          const message = '无法确认 Harness 已停止，请关闭正在运行的任务后重试。';
          if (current === record) publish({ state: 'error', message, origin: null });
          record.stopping = false;
          record.stopPromise = null;
          throw new Error(message);
        }
      }
      if (current === record) {
        current = null;
        publish({ state: 'stopped', message: 'Harness 已停止', origin: null });
      }
    })();
    return record.stopPromise;
  }

  async function start({ workspace } = {}) {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || !fs.statSync(workspace, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('请选择存在的本地项目文件夹。');
    }
    const resolved = fs.realpathSync(workspace);
    if (current && current.workspace === resolved && !current.stopping) return current.ready;
    const request = ++revision;
    if (current) await stopRecord(current);
    if (request !== revision) throw new Error('Harness 启动已取消。');
    try {
      let launchConfig = {};
      if (prepareLaunch) {
        const pending = { promise: Promise.resolve().then(prepareLaunch) };
        preparation = pending;
        publish({ state: 'starting', message: '正在准备共享平台连接…', workspace: resolved, origin: null });
        try { launchConfig = await pending.promise; }
        finally { if (preparation === pending) preparation = null; }
      }
      if (request !== revision) throw new Error('Harness 启动已取消。');
      return await launch(resolved, launchConfig);
    }
    catch (error) {
      if (!current && request === revision) publish({ state: 'error', message: sanitizeOutput(error.message), workspace: resolved, origin: null });
      throw error;
    }
  }

  async function stop() {
    revision += 1;
    if (preparation) await preparation.promise.catch(() => {});
    if (current) await stopRecord(current);
    else publish({ state: 'stopped', message: 'Harness 已停止', origin: null });
  }

  return { start, stop, isActive: () => Boolean(preparation || (current && !current.exited)), getStatus: () => ({ ...status }) };
}

module.exports = { createHarnessManager, SUPPORTED_HARNESS_VERSION, sanitizeOutput, parseReadyUrl };
