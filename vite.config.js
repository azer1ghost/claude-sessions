import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    port: 5180,
    strictPort: true,
    watch: { ignored: ['**/.cache/**'] },
    proxy: { '/api': 'http://127.0.0.1:5179' },
  },
})
