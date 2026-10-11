import {test, expect} from '@playwright/test'
import {zipSync, strToU8} from 'fflate'
import {readFile} from 'node:fs/promises'

// Synthetic local audio and transcript; never use private recordings as fixtures.
function fixture() {
  const audio = Buffer.alloc(44 + 16000 * 2)
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8)
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34)
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40)
  const project = {id: 'fixture', name: 'Local fixture', revision: 0, status: 'done', error: null, duration: 1, progress: 100,
    segments: [{id: 0, start: 0, end: 1, text: 'Private local transcript'}], events: [], versions: [], source_kind: 'audio'}
  return Buffer.from(zipSync({'project.json': strToU8(JSON.stringify(project)), 'audio.wav': audio}, {level: 0}))
}

test('local editor persists, exports, restores history and backup without network uploads', async ({page, context, browser}) => {
  const mutations: string[] = []
  const apis: string[] = []
  context.on('request', request => {
    if (!['GET', 'HEAD'].includes(request.method())) mutations.push(request.url())
    if (new URL(request.url()).pathname.startsWith('/api/')) apis.push(request.url())
  })
  page.on('dialog', dialog => dialog.accept())
  await page.goto('/')
  await page.locator('input[type=file]').setInputFiles({name: 'fixture.lts', mimeType: 'application/zip', buffer: fixture()})
  await expect(page.locator('.text-fragment')).toHaveText('Private local transcript')
  await page.locator('.text-fragment').dblclick()
  await page.locator('textarea').fill('Edited entirely locally')
  await page.locator('textarea').blur()
  await expect(page.getByRole('button', {name: '保存', exact: true})).toBeDisabled()
  await page.reload()
  await page.locator('.project-list button').click()
  await expect(page.locator('.text-fragment')).toHaveText('Edited entirely locally')
  await page.getByRole('button', {name: '历史版本', exact: true}).click()
  await expect(page.locator('.version-row')).toHaveCount(2)
  await page.locator('.version-row').last().getByRole('button', {name: '恢复'}).click()
  await expect(page.locator('.text-fragment')).toHaveText('Private local transcript')
  for (const name of ['Markdown', 'SRT 字幕']) {
    const downloading = page.waitForEvent('download')
    await page.getByRole('button', {name, exact: true}).click()
    const result = await downloading
    expect(await readFile((await result.path())!, 'utf8')).toContain('Private local transcript')
  }
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', {name: '项目备份', exact: true}).click()
  const backup = await downloading
  await page.locator('input[type=file]').setInputFiles({name:'restored.lts', mimeType:'application/zip', buffer: await readFile((await backup.path())!)})
  await expect(page.locator('.project-list button')).toHaveCount(2)
  const separate = await browser.newContext()
  const other = await separate.newPage()
  await other.goto('http://127.0.0.1:8011')
  await expect(other.locator('.project-list button')).toHaveCount(0)
  await separate.close()
  expect(mutations).toEqual([])
  expect(apis).toEqual([])
})

test('website cannot accept recordings or expose legacy private projects', async ({request}) => {
  expect((await request.post('/api/projects', {data: 'private recording'})).status()).toBe(501)
  expect((await request.get('/api/projects')).status()).toBe(404)
  expect((await request.get('/projects/')).status()).toBe(404)
  const response = await request.get('/')
  expect(response.headers()['content-security-policy']).toContain("connect-src 'self' blob:")
  expect((await request.get('/runtime/ffmpeg-core.wasm')).headers()['content-type']).toBe('application/wasm')
})

test('optional real Whisper inference with a supplied synthetic speech fixture', async ({page, context}) => {
  test.skip(!process.env.LTS_TEST_AUDIO, 'Set LTS_TEST_AUDIO to a synthetic speech WAV')
  const uploads: string[] = []
  context.on('request', request => {if (!['GET', 'HEAD'].includes(request.method())) uploads.push(request.url())})
  await page.goto('/')
  await page.locator('input[type=file]').setInputFiles(process.env.LTS_TEST_AUDIO!)
  await expect(page.locator('.transcribe-controls select')).toHaveCount(3)
  await page.locator('.transcribe-controls select').nth(1).selectOption('tiny')
  await page.locator('.transcribe-controls select').nth(2).selectOption('en')
  await page.getByRole('button', {name:'开始转写',exact:true}).click()
  await expect(page.locator('.status-chip')).toHaveText('已转写', {timeout: 100000})
  await expect(page.locator('.text-fragment').first()).not.toBeEmpty()
  page.on('dialog', dialog => dialog.accept())
  await page.locator('.transcribe-toggle').click()
  await page.getByRole('button', {name:'重新转写',exact:true}).click()
  await page.getByRole('button', {name:'终止转写',exact:true}).click()
  await expect(page.locator('.status-chip')).toHaveText('已终止')
  await page.reload()
  await page.locator('.project-list button').click()
  await expect(page.locator('.status-chip')).toHaveText('已终止')
  expect(uploads).toEqual([])
})
