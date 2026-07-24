'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { _electron: electron } = require('playwright');

const projectRoot = path.resolve(__dirname, '..', '..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let launchedProcess = null;

function killLaunchedProcessTree() {
  if (!launchedProcess?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(launchedProcess.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    launchedProcess.kill('SIGKILL');
  } catch {
    // The isolated smoke process may already be gone.
  }
}

function declaredTrayMenuLabels() {
  const source = fs.readFileSync(path.join(projectRoot, 'electron', 'main.js'), 'utf8');
  const labels = [...source.matchAll(/label\s*:\s*(['"])(Show|Exit)\1/g)].map((match) => match[2]);
  const declared = [...new Set(labels)];
  for (const expected of ['Show', 'Exit']) {
    if (!declared.includes(expected)) {
      throw new Error(`Tray context menu is missing the ${expected} command`);
    }
  }
  if (!/label\s*:\s*(['"])Show\1\s*,\s*click\s*:\s*\(\)\s*=>\s*showMainWindow\(\)/.test(source)) {
    throw new Error('Tray Show command is not connected to showMainWindow()');
  }
  if (!/label\s*:\s*(['"])Exit\1\s*,\s*click\s*:\s*\(\)\s*=>\s*requestAppExit\(\)/.test(source)) {
    throw new Error('Tray Exit command is not connected to requestAppExit()');
  }
  return declared;
}

async function windowState(app, id) {
  return app.evaluate(({ BrowserWindow }, windowId) => {
    const win = BrowserWindow.fromId(windowId);
    return {
      exists: !!win,
      destroyed: !win || win.isDestroyed(),
      visible: !!win && win.isVisible(),
      minimized: !!win && win.isMinimized(),
    };
  }, id);
}

async function waitForState(app, id, predicate, description, timeout = 5_000) {
  const startedAt = Date.now();
  let state = await windowState(app, id);
  while (!predicate(state) && Date.now() - startedAt < timeout) {
    await wait(50);
    state = await windowState(app, id);
  }
  if (!predicate(state)) {
    throw new Error(`${description}: ${JSON.stringify(state)}`);
  }
  return state;
}

const isHiddenTrayWindow = (state) =>
  state.exists && !state.destroyed && !state.visible && !state.minimized;

async function showWindow(app, id) {
  await app.evaluate(({ BrowserWindow }, windowId) => {
    const win = BrowserWindow.fromId(windowId);
    if (!win || win.isDestroyed()) throw new Error('Main window was destroyed');
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }, id);
  await waitForState(
    app,
    id,
    (state) => state.exists && !state.destroyed && state.visible && !state.minimized,
    'Window did not restore',
  );
}

async function run() {
  const menuLabels = declaredTrayMenuLabels();
  const app = await electron.launch({
    args: ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      // Keep this lifecycle test independent of a running CRM API.
      CRM_API_URL: 'http://127.0.0.1:1',
      CRM_CDMS_DISABLED: '1',
    },
    timeout: 30_000,
  });
  launchedProcess = app.process();

  try {
    const page = await app.firstWindow({ timeout: 20_000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() =>
      !!window.dashboardWindowControls
      && !!document.querySelector('.window-close-control'), null, { timeout: 20_000 });

    const mainWindowId = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.isVisible())?.id);
    if (!mainWindowId) throw new Error('No visible CRM main window was created');

    // Exercise the actual custom titlebar X, including the preload capture
    // binding that must remain authoritative across renderer hydration.
    await page.click('.window-close-control');
    const titlebarClose = await waitForState(
      app,
      mainWindowId,
      isHiddenTrayWindow,
      'Titlebar X did not hide a live, non-minimized window',
    );

    await showWindow(app, mainWindowId);
    // BrowserWindow.close() models Alt+F4 and taskbar-thumbnail Close.
    await app.evaluate(({ BrowserWindow }, windowId) => {
      const win = BrowserWindow.fromId(windowId);
      setTimeout(() => win?.close(), 0);
    }, mainWindowId);
    const nativeClose = await waitForState(
      app,
      mainWindowId,
      isHiddenTrayWindow,
      'Native close did not hide a live, non-minimized window',
    );

    await showWindow(app, mainWindowId);
    // Keep the obsolete renderer bridge safe for stale layouts or extensions.
    await page.evaluate(() => {
      window.dashboardWindowControls.minimize();
    });
    const legacyMinimize = await waitForState(
      app,
      mainWindowId,
      isHiddenTrayWindow,
      'Legacy minimize did not hide a live, non-minimized window',
    );

    await showWindow(app, mainWindowId);
    // Also cover a native/programmatic minimize event: it must be restored out
    // of the taskbar-minimized state before being hidden behind the tray icon.
    await app.evaluate(({ BrowserWindow }, windowId) => {
      const win = BrowserWindow.fromId(windowId);
      setTimeout(() => win?.minimize(), 0);
    }, mainWindowId);
    const nativeMinimize = await waitForState(
      app,
      mainWindowId,
      isHiddenTrayWindow,
      'Native minimize did not normalize to a hidden tray window',
    );

    return {
      menuLabels,
      titlebarClose,
      nativeClose,
      legacyMinimize,
      nativeMinimize,
    };
  } finally {
    killLaunchedProcessTree();
  }
}

const watchdog = setTimeout(() => {
  killLaunchedProcessTree();
  console.error('Tray lifecycle smoke timed out');
  process.exit(2);
}, 45_000);

run().then((evidence) => {
  clearTimeout(watchdog);
  console.log('[tray-lifecycle-smoke]', JSON.stringify(evidence));
  process.exit(0);
}, (error) => {
  clearTimeout(watchdog);
  killLaunchedProcessTree();
  console.error(error);
  process.exit(1);
});
