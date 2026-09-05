const test = require('node:test')
const assert = require('node:assert/strict')
const { captureGenerationSnapshot, classifyGenerationSnapshot } = require('../src/dola-adapter')

test('keeps the injected Dola snapshot collector syntactically valid', async () => {
  let captured = ''
  const contents = {
    isDestroyed: () => false,
    executeJavaScript: expression => {
      captured = expression
      new Function(`return ${expression}`)
      return Promise.resolve({ media: [], statusText: [] })
    }
  }
  await captureGenerationSnapshot(contents)
  assert.match(captured, /findReactVideoUrl/)
})

test('classifies a new generated result against the prepared baseline', () => {
  const result = classifyGenerationSnapshot(
    { baselineUrls: ['https://example.com/example.png'] },
    {
      media: [
        { type: 'image', url: 'https://example.com/example.png' },
        { type: 'image', url: 'https://example.com/generated.png' }
      ],
      statusText: []
    }
  )
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.results, [{ type: 'image', url: 'https://example.com/generated.png' }])
})

test('keeps polling while Dola reports generation progress', () => {
  const result = classifyGenerationSnapshot(
    { baselineUrls: [] },
    { media: [], statusText: ['正在生成，请稍候'] }
  )
  assert.equal(result.status, 'generating')
})

test('surfaces Dola failures without inventing a result', () => {
  const result = classifyGenerationSnapshot(
    { baselineUrls: [] },
    { media: [], statusText: ['额度不足，生成失败'] }
  )
  assert.equal(result.status, 'failed')
  assert.equal(result.results.length, 0)
})
