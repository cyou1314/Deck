const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizedRegionToPixels } = require('../src/media')

test('converts normalized watermark region to safe pixels', () => {
  assert.deepEqual(
    normalizedRegionToPixels({ x: 0.75, y: 0.8, w: 0.2, h: 0.12 }, 1920, 1080),
    { x: 1440, y: 864, w: 384, h: 130 }
  )
})

test('clamps a region that exceeds the frame', () => {
  assert.deepEqual(
    normalizedRegionToPixels({ x: 0.95, y: 0.95, w: 0.5, h: 0.5 }, 100, 100),
    { x: 95, y: 95, w: 5, h: 5 }
  )
})
