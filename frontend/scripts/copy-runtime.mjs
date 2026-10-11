import {mkdir, copyFile, readdir, cp, access} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
const root = new URL('../', import.meta.url)
const runtime = new URL('dist/runtime/', root)
await mkdir(runtime, {recursive: true})
for (const name of await readdir(new URL('node_modules/onnxruntime-web/dist/', root))) {
  if (/^ort-wasm.*\.(wasm|mjs)$/.test(name)) await copyFile(new URL('node_modules/onnxruntime-web/dist/' + name, root), new URL(name, runtime))
}
for (const name of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  await copyFile(new URL('node_modules/@ffmpeg/core/dist/esm/' + name, root), new URL(name, runtime))
}
console.log('Browser runtimes copied to ' + fileURLToPath(runtime))
const models = new URL('../.browser-models/', root)
let present = true
try {await access(models)} catch {present = false}
if (present) await cp(models, new URL('dist/models/', root), {recursive: true})
else console.log('未附带模型；部署前运行 python3 scripts/download-browser-models.py')
