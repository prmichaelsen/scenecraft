import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // Leading dot = subdomain wildcard. Covers any tenant we vend under
  // scenecraft.online without per-host changes. Blocks rebinding from
  // arbitrary external domains.
  server: { allowedHosts: ['.scenecraft.online'] },
  preview: { allowedHosts: ['.scenecraft.online'] },
  plugins: [
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})
