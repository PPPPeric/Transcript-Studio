import {defineConfig} from '@playwright/test'
export default defineConfig({
  testDir: './tests',
  timeout: 120000,
  use: {baseURL: 'http://127.0.0.1:8011', browserName: 'chromium', headless: true,
    launchOptions: process.env.LTS_TEST_CHROME ? {executablePath: process.env.LTS_TEST_CHROME} : {}},
  webServer: {command: 'python3 ../scripts/serve-browser.py --port 8011', url: 'http://127.0.0.1:8011/health.json', reuseExistingServer: true},
})
