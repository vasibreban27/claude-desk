// Renders build/icon.svg to PNGs with sharp and packs them into build/icon.ico (PNG-compressed ICO entries).
// Run: node scripts/make-icon.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const svg = readFileSync(path.join(root, 'build', 'icon.svg'))
const sizes = [16, 24, 32, 48, 64, 128, 256]

const pngs = await Promise.all(sizes.map((s) => sharp(svg, { density: 384 }).resize(s, s).png().toBuffer()))

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(sizes.length, 4)

const entries = []
let offset = 6 + 16 * sizes.length
sizes.forEach((s, i) => {
  const e = Buffer.alloc(16)
  e.writeUInt8(s >= 256 ? 0 : s, 0) // width (0 means 256)
  e.writeUInt8(s >= 256 ? 0 : s, 1) // height
  e.writeUInt8(0, 2) // palette
  e.writeUInt8(0, 3) // reserved
  e.writeUInt16LE(1, 4) // color planes
  e.writeUInt16LE(32, 6) // bits per pixel
  e.writeUInt32LE(pngs[i].length, 8)
  e.writeUInt32LE(offset, 12)
  offset += pngs[i].length
  entries.push(e)
})

writeFileSync(path.join(root, 'build', 'icon.ico'), Buffer.concat([header, ...entries, ...pngs]))
writeFileSync(path.join(root, 'build', 'icon.png'), pngs[pngs.length - 1])
console.log('wrote build/icon.ico and build/icon.png')
