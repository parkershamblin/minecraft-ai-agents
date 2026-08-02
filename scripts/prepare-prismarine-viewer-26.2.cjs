const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Install prismarine-viewer 26.2 atlas/blockStates into the package public/
 * tree after npm install.
 *
 * MineBot generates these with real `canvas`. This repo stubs canvas → noop2
 * (browser POV renders client-side; see sidecar.ts), so generation cannot run
 * in postinstall/Docker. We ship the MineBot-built assets under
 * vendor/prismarine-viewer-26.2-assets/ and copy them into place. If a real
 * canvas is ever available and the vendor stamp mismatches, regenerate.
 */

const viewerVersion = '26.2'
const fallbackAssetVersion = '1.21.8'
const vendorRoot = path.join(__dirname, '..', 'vendor', 'prismarine-viewer-26.2-assets')
const vendorTexture = path.join(vendorRoot, 'textures', `${viewerVersion}.png`)
const vendorBlockStates = path.join(vendorRoot, 'blocksStates', `${viewerVersion}.json`)
const vendorStamp = path.join(vendorRoot, 'blocksStates', `${viewerVersion}.stamp.json`)

const viewerPublic = path.dirname(require.resolve('prismarine-viewer/public/index.html'))
const texturesDirectory = path.join(viewerPublic, 'textures')
const blockStatesDirectory = path.join(viewerPublic, 'blocksStates')
const textureOutput = path.join(texturesDirectory, `${viewerVersion}.png`)
const blockStatesOutput = path.join(blockStatesDirectory, `${viewerVersion}.json`)
const stampOutput = path.join(blockStatesDirectory, `${viewerVersion}.stamp.json`)

function readJson (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function canvasUsable () {
  try {
    const canvas = require('canvas')
    return typeof canvas.createCanvas === 'function'
  } catch {
    return false
  }
}

function installFromVendor () {
  if (!fs.existsSync(vendorTexture) || !fs.existsSync(vendorBlockStates) || !fs.existsSync(vendorStamp)) {
    throw new Error(
      `Missing vendored prismarine-viewer ${viewerVersion} assets under ${vendorRoot}. ` +
      'Copy textures/26.2.png + blocksStates/26.2.json(+.stamp.json) from a MineBot install, ' +
      'or run this script on a host with real canvas + minecraft-assets.'
    )
  }

  fs.mkdirSync(texturesDirectory, { recursive: true })
  fs.mkdirSync(blockStatesDirectory, { recursive: true })
  fs.copyFileSync(vendorTexture, textureOutput)
  fs.copyFileSync(vendorBlockStates, blockStatesOutput)
  fs.copyFileSync(vendorStamp, stampOutput)

  const stamp = readJson(stampOutput)
  console.log(
    `Installed prismarine-viewer ${viewerVersion} compatibility assets from vendor ` +
    `(${stamp?.blockStateCount ?? '?'} block states, generatedFrom=${stamp?.generatedFrom ?? '?'})`
  )
}

function regenerateWithCanvas () {
  const inputFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    viewerVersion,
    fallbackAssetVersion,
    script: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    viewer: require('prismarine-viewer/package.json').version,
    assets: require('minecraft-assets/package.json').version
  })).digest('hex')

  const installed = readJson(stampOutput)
  if (
    fs.existsSync(textureOutput) &&
    fs.existsSync(blockStatesOutput) &&
    installed?.inputFingerprint === inputFingerprint
  ) {
    console.log(`prismarine-viewer ${viewerVersion} compatibility assets already prepared`)
    return
  }

  const minecraftAssets = require('minecraft-assets')(fallbackAssetVersion)
  const { makeTextureAtlas } = require('prismarine-viewer/viewer/lib/atlas')
  const { prepareBlocksStates } = require('prismarine-viewer/viewer/lib/modelsBuilder')

  if (!minecraftAssets) {
    throw new Error(`minecraft-assets does not include fallback version ${fallbackAssetVersion}`)
  }

  fs.mkdirSync(texturesDirectory, { recursive: true })
  fs.mkdirSync(blockStatesDirectory, { recursive: true })

  const atlas = makeTextureAtlas(minecraftAssets)
  const blockStates = prepareBlocksStates(minecraftAssets, atlas)
  const blockStateCount = Object.keys(blockStates).length
  if (blockStateCount < 100) {
    throw new Error(`Generated only ${blockStateCount} block states from ${fallbackAssetVersion}; the asset source looks wrong`)
  }

  fs.writeFileSync(textureOutput, atlas.image)
  fs.writeFileSync(blockStatesOutput, JSON.stringify(blockStates))
  fs.writeFileSync(stampOutput, JSON.stringify({
    inputFingerprint,
    generatedFrom: fallbackAssetVersion,
    blockStateCount,
    atlasSha256: crypto.createHash('sha256').update(atlas.image).digest('hex')
  }, null, 2))

  console.log(
    `Prepared prismarine-viewer ${viewerVersion} compatibility assets from ${fallbackAssetVersion} ` +
    `(${blockStateCount} block states)`
  )
}

const vendorStampData = readJson(vendorStamp)
const installedStamp = readJson(stampOutput)
const vendorReady =
  fs.existsSync(vendorTexture) &&
  fs.existsSync(vendorBlockStates) &&
  vendorStampData != null

if (
  vendorReady &&
  fs.existsSync(textureOutput) &&
  fs.existsSync(blockStatesOutput) &&
  installedStamp?.atlasSha256 === vendorStampData.atlasSha256
) {
  console.log(`prismarine-viewer ${viewerVersion} compatibility assets already prepared`)
  process.exit(0)
}

if (vendorReady) {
  installFromVendor()
  process.exit(0)
}

if (canvasUsable()) {
  regenerateWithCanvas()
  process.exit(0)
}

throw new Error(
  `Cannot prepare prismarine-viewer ${viewerVersion} assets: no vendor copy at ${vendorRoot} ` +
  'and canvas is unavailable (this repo stubs canvas → noop2).'
)
