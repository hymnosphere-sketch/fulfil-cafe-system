import { defineConfig } from 'vite'
import { resolve, basename } from 'node:path'
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

function buildIdPlugin() {
  return {
    name: 'build-id',
    generateBundle() {
      const buildId = Date.now().toString(36)
      // Inject build ID into service worker
      const swPath = resolve(__dirname, 'dist/sw.js')
      if (this.getFileName(swPath)) {
        let swContent = readFileSync(swPath, 'utf-8')
        swContent = swContent.replace('__BUILD_ID__', buildId)
        writeFileSync(swPath, swContent)
      }
    },
    closeBundle() {
      // Copy service worker from public to dist
      const publicSw = resolve(__dirname, 'public/sw.js')
      const distSw = resolve(__dirname, 'dist/sw.js')
      copyFileSync(publicSw, distSw)
      // Now inject build ID
      let swContent = readFileSync(distSw, 'utf-8')
      swContent = swContent.replace('__BUILD_ID__', Date.now().toString(36))
      writeFileSync(distSw, swContent)
    },
  }
}

export default defineConfig({
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    manifest: true,
    rollupOptions: {
      input: resolve(__dirname, 'index.html'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  plugins: [buildIdPlugin()],
})