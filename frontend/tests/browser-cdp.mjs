import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

export const quote = JSON.stringify
export const element = (selector) => 'document.querySelector(' + quote(selector) + ')'
export const visible = (selector) => 'Array.from(document.querySelectorAll(' + quote(selector) + ')).find(node => node.getClientRects().length && !node.closest("[inert]"))'

export async function connectBrowser(endpoint) {
  const response = await fetch(endpoint + '/json/version')
  assert.ok(response.ok, 'Chrome exposes a browser CDP socket')
  const { webSocketDebuggerUrl } = await response.json()
  const socket = new WebSocket(webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })

  let nextCommand = 0
  const pending = new Map()
  const handlers = new Map()
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.id !== undefined) {
      const command = pending.get(message.id)
      if (!command) return
      pending.delete(message.id)
      clearTimeout(command.timeout)
      if (message.error) command.reject(new Error(message.error.message))
      else command.resolve(message.result)
      return
    }
    handlers.get(message.sessionId)?.(message)
  })

  function send(method, params, sessionId) {
    const id = ++nextCommand
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error('Chrome command timed out: ' + method))
      }, 15_000)
      pending.set(id, { resolve, reject, timeout })
      socket.send(JSON.stringify({ id, method, params, sessionId }))
    })
  }

  async function context({ persistent = false } = {}) {
    const { browserContextId } = persistent ? {} : await send('Target.createBrowserContext', {})
    const sessions = new Map()

    async function page({ script, width = 1440, height = 900 } = {}) {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId })
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
      sessions.set(sessionId, targetId)
      const cdp = (method, params = {}) => send(method, params, sessionId)
      const exceptions = []
      const consoleErrors = []
      handlers.set(sessionId, (message) => {
        if (message.method === 'Runtime.exceptionThrown') {
          const { description } = message.params.exceptionDetails.exception ?? {}
          exceptions.push(description ?? message.params.exceptionDetails.text)
        }
        if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
          consoleErrors.push(message.params.args.map(({ value, description }) => value ?? description).join(' '))
        }
      })
      await cdp('Page.enable')
      await cdp('Runtime.enable')
      if (script) await cdp('Page.addScriptToEvaluateOnNewDocument', { source: script })
      const resize = (width, height) => cdp('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
      })
      await resize(width, height)

      async function evaluate(expression) {
        const { result, exceptionDetails } = await cdp('Runtime.evaluate', {
          expression, returnByValue: true, awaitPromise: true,
        })
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
        return result.value
      }

      async function until(expression, label) {
        for (let attempt = 0; attempt < 160; attempt += 1) {
          if (await evaluate(expression).catch(() => false)) return
          await delay(50)
        }
        const content = await evaluate('document.querySelector("main")?.innerText.slice(0, 750)').catch(() => '')
        assert.fail('Timed out waiting for ' + label + '. Page content: ' + content)
      }

      async function click(selector) {
        // Evaluate lookup and action together because a navigation can replace the previous DOM.
        await until(`(() => {
          const control = ${visible(selector)}
          if (!control || control.matches(':disabled')) return false
          control.click()
          return true
        })()`, selector)
      }

      async function setField(selector, value) {
        await until(`(() => {
          const field = ${element(selector)}
          if (!field || field.matches(':disabled')) return false
          field.value = ${quote(value)}
          field.dispatchEvent(new Event(field.matches('select') ? 'change' : 'input', { bubbles: true }))
          return true
        })()`, selector)
      }

      async function goto(url) {
        const navigation = await cdp('Page.navigate', { url })
        assert.ok(!navigation.errorText, navigation.errorText)
        await until('location.href !== "about:blank" && document.readyState !== "loading"', 'new document')
      }

      async function reload() {
        const started = await evaluate('performance.timeOrigin')
        await cdp('Page.reload')
        await until(`performance.timeOrigin !== ${started} && document.readyState !== "loading"`, 'replacement document')
      }

      return {
        cdp, evaluate, until, click, setField, goto, reload, resize, exceptions, consoleErrors,
        async close() {
          handlers.delete(sessionId)
          sessions.delete(sessionId)
          await send('Target.closeTarget', { targetId })
        },
      }
    }

    return {
      page,
      async dispose() {
        for (const [sessionId, targetId] of sessions) {
          handlers.delete(sessionId)
          if (persistent) await send('Target.closeTarget', { targetId })
        }
        if (!persistent) await send('Target.disposeBrowserContext', { browserContextId })
      },
    }
  }

  return { context, commandLine: () => send('Browser.getBrowserCommandLine', {}), close: () => socket.close() }
}
