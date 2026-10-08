import { copyFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'static', 'dashboard.html')
const targetDir = join(root, 'dist', 'static')
const target = join(targetDir, 'dashboard.html')

mkdirSync(targetDir, { recursive: true })
copyFileSync(source, target)
console.log(`[sync-server] copied ${source} -> ${target}`)
