import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({plugins: [react()], server: {proxy: {'/models': 'http://127.0.0.1:8001', '/runtime': 'http://127.0.0.1:8001'}}})
