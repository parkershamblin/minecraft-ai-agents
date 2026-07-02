// loading the mineflayer library
const mineflayer = require('mineflayer')

// creating a bot with the library
const bot = mineflayer.createBot({
    host: 'localhost',
    port: 25565,
    username: 'lookAt_Bot'
})

function lookAtNearestPlayer() {
    const playerFilter = (entitiy) => entitiy.type === 'player'
    const playerEntity = bot.nearestEntity(playerFilter);

    if (!playerEntity) return

    const pos = playerEntity.position.offset(0, playerEntity.height, 0)
    bot.lookAt(pos)
}

bot.on('physicTick', lookAtNearestPlayer)
