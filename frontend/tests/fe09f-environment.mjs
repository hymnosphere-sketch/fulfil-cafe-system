import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { createServer, preview } from 'vite'
import { connectBrowser } from './browser-cdp.mjs'

async function startFlask(origin, python, backend) {
  const path = fileURLToPath(new URL('fe09f-flask.py', import.meta.url))
  const child = spawn(python, ['-u', path, backend, origin, '--browser-tests'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  const lines = createInterface({ input: child.stdout })
  const exited = once(child, 'exit')
  try {
    const [line] = await Promise.race([once(lines, 'line'), exited.then(() => { throw new Error('Flask failed to start.') })])
    return { urls: JSON.parse(line), async close() {
      child.stdin.end()
      assert.equal((await exited)[0], 0)
    } }
  } catch (error) {
    child.kill()
    throw error
  }
}

async function startChrome(chromeBin, profile) {
  await rm(join(profile, 'DevToolsActivePort'), { force: true })
  const child = spawn(chromeBin, [
    '--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-extensions',
    '--no-first-run', '--enable-automation', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  let endpoint, browser
  try {
    await once(child, 'spawn')
    for (let attempt = 0; attempt < 150 && !browser; attempt++) {
      try {
        const port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]
        endpoint = 'http://127.0.0.1:' + port
        browser = await connectBrowser(endpoint)
      } catch { await delay(100) }
    }
    assert.ok(browser, 'Chrome exposes its loopback debugging port')
    const context = await browser.context({ persistent: true })
    return { context, pid: child.pid, async close() {
      try {
        await context.dispose()
        const { webSocketDebuggerUrl } = await (await fetch(endpoint + '/json/version')).json()
        const socket = new WebSocket(webSocketDebuggerUrl)
        await once(socket, 'open')
        const exited = once(child, 'exit')
        socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
        assert.equal((await exited)[0], 0, 'Chrome exited and flushed IndexedDB')
        socket.close()
      } finally {
        browser.close()
        if (child.exitCode === null) child.kill()
      }
    } }
  } catch (error) {
    browser?.close()
    child.kill()
    throw error
  }
}

export async function withIntegrationEnvironment(run) {
  const { FE09F_CHROME_BIN: chromeBin, FE09F_BACKEND_ROOT: backend, FE09F_PYTHON: python = 'python' } = process.env
  assert.ok(chromeBin && backend, 'Set FE09F_CHROME_BIN and FE09F_BACKEND_ROOT.')
  const temporary = await mkdtemp(join(tmpdir(), 'fulfil-fe09f-browser-'))
  const profile = join(temporary, 'chrome')
  await mkdir(profile)
  let dev, prod, flask, chrome
  try {
    dev = await createServer({
      cacheDir: join(temporary, 'vite'),
      optimizeDeps: { entries: ['index.html', 'tests/fe09f-integration.html'] },
      server: { host: '127.0.0.1', port: 0, watch: null },
    })
    await dev.listen()
    await dev.waitForRequestsIdle()
    prod = await preview({ preview: { host: '127.0.0.1', port: 0 } })
    const app = 'http://127.0.0.1:' + dev.httpServer.address().port
    const production = 'http://127.0.0.1:' + prod.httpServer.address().port
    flask = await startFlask(app, python, backend)
    chrome = await startChrome(chromeBin, profile)
    await run({
      app, production, urls: flask.urls,
      page: (options) => chrome.context.page(options),
      async restartChrome() {
        const previous = chrome.pid
        await chrome.close()
        chrome = undefined
        chrome = await startChrome(chromeBin, profile)
        assert.notEqual(chrome.pid, previous)
      },
    })
  } finally {
    await Promise.all([chrome?.close(), flask?.close(), dev?.close(),
      new Promise((resolve) => prod ? prod.httpServer.close(resolve) : resolve())])
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
