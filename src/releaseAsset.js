function getLatestReleaseAsset(assets, {
    os,
    format,
    architecture = null
}) {
    if (!Array.isArray(assets)) return undefined

    return assets
        .filter(asset => {
            const name = String(asset?.name || '').toLowerCase()
            const matchesOS = name.includes(String(os).toLowerCase())
            const matchesFormat = name.endsWith(String(format).toLowerCase())
            const matchesArchitecture = !architecture
                || name.includes(`-${String(architecture).toLowerCase()}.`)

            return matchesOS && matchesFormat && matchesArchitecture
        })
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
}

module.exports = { getLatestReleaseAsset }
