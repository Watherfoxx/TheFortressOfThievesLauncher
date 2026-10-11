const { deflateRawSync } = require('node:zlib')

module.exports = function forgeJar(content = 'fixture class content', compressed = true) {
    const name = Buffer.from('org/objectweb/asm/commons/Remapper.class')
    const data = Buffer.from(content)
    let crc = 0xffffffff
    for (const byte of data) {
        crc ^= byte
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    crc = (crc ^ 0xffffffff) >>> 0
    const payload = compressed ? deflateRawSync(data) : data
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(compressed ? 8 : 0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(compressed ? 8 : 0, 10)
    directory.writeUInt32LE(crc, 16)
    directory.writeUInt32LE(payload.length, 20)
    directory.writeUInt32LE(data.length, 24)
    directory.writeUInt16LE(name.length, 28)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(1, 8)
    end.writeUInt16LE(1, 10)
    end.writeUInt32LE(directory.length + name.length, 12)
    end.writeUInt32LE(local.length + name.length + payload.length, 16)
    return Buffer.concat([local, name, payload, directory, name, end])
}
