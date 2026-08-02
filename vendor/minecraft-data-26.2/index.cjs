const path = require('node:path')

const base = require('minecraft-data-base')
const baseRoot = path.dirname(require.resolve('minecraft-data-base/package.json'))
const mcDataToNode = require(path.join(baseRoot, 'lib', 'loader.js'))
const supportFeature = require(path.join(baseRoot, 'lib', 'supportsFeature.js'))

const localDataRoot = path.join(__dirname, 'data', 'pc', '26.2')
const baseDataRoot = path.join(baseRoot, 'minecraft-data', 'data')

function localData (name) {
  return require(path.join(localDataRoot, `${name}.json`))
}

function baseData (relativePath) {
  return require(path.join(baseDataRoot, relativePath))
}

const raw26_2 = {
  attributes: localData('attributes'),
  blockCollisionShapes: localData('blockCollisionShapes'),
  blocks: localData('blocks'),
  blockLoot: baseData(path.join('pc', '1.20', 'blockLoot.json')),
  biomes: localData('biomes'),
  commands: baseData(path.join('pc', '1.20.3', 'commands.json')),
  effects: localData('effects'),
  enchantments: localData('enchantments'),
  entities: localData('entities'),
  entityLoot: baseData(path.join('pc', '1.20', 'entityLoot.json')),
  foods: localData('foods'),
  instruments: localData('instruments'),
  items: localData('items'),
  language: localData('language'),
  loginPacket: localData('loginPacket'),
  mapIcons: baseData(path.join('pc', '1.20.2', 'mapIcons.json')),
  materials: localData('materials'),
  particles: localData('particles'),
  protocol: localData('protocol'),
  recipes: localData('recipes'),
  sounds: localData('sounds'),
  tints: localData('tints'),
  version: localData('version'),
  windows: baseData(path.join('pc', '1.16.1', 'windows.json')),
  proto: path.join(baseDataRoot, 'pc', 'latest', 'proto.yml')
}

let cached26_2

function is26_2Version (mcVersion, preNetty) {
  if (preNetty || mcVersion == null) return false

  const normalized = String(mcVersion).replace('pe_', 'bedrock_')
  if (normalized.startsWith('bedrock_')) return false

  const byName = base.versionsByMinecraftVersion.pc[normalized]
  if (byName?.majorVersion === '26.2') return true

  const byProtocol = base.postNettyVersionsByProtocolVersion.pc[normalized]
  return Boolean(byProtocol?.some(version => version.majorVersion === '26.2'))
}

function load26_2 () {
  if (cached26_2) return cached26_2

  const data = mcDataToNode(raw26_2)
  data.type = 'pc'
  data.version = Object.assign(
    new base.Version('pc', '26.2', '26.2'),
    data.version
  )
  data.isNewerOrEqualTo = version => data.version['>='](version)
  data.isOlderThan = version => data.version['<'](version)
  data.supportFeature = supportFeature(data.version, base.versions.pc)
  cached26_2 = data
  return data
}

function minecraftData (mcVersion, preNetty) {
  if (is26_2Version(mcVersion, preNetty)) return load26_2()
  return base(mcVersion, preNetty)
}

Object.assign(minecraftData, base)
minecraftData.supportedVersions = {
  ...base.supportedVersions,
  pc: base.supportedVersions.pc.includes('26.2')
    ? base.supportedVersions.pc
    : [...base.supportedVersions.pc, '26.2']
}

module.exports = minecraftData
