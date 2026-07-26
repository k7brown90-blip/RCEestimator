// One-off placeholder icon generator (solid brand-color PNGs).
// Run: node scripts/generate-icons.mjs — replace output with real brand icons later.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function solidPng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 4)])
  for (let x = 0; x < size; x += 1) {
    row[1 + x * 4] = r
    row[2 + x * 4] = g
    row[3 + x * 4] = b
    row[4 + x * 4] = 255
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const brand = [0x18, 0x36, 0x4f] // matches theme_color gradient
mkdirSync(join(root, 'public'), { recursive: true })
for (const size of [192, 512]) {
  writeFileSync(join(root, 'public', `pwa-${size}x${size}.png`), solidPng(size, brand))
  console.log(`wrote public/pwa-${size}x${size}.png`)
}
