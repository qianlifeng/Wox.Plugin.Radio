// Run after `pnpm exec tsc`; this connects to a live station and plays audio.
const { RadioPlayer } = require("../dist/player.js")
const { searchStations } = require("../dist/directory.js")
const { tmpdir } = require("node:os")

async function main() {
  const [station] = await searchStations("", { country: "US", genre: "jazz" }, 1)
  if (!station) throw new Error("No station available")
  const player = new RadioPlayer(tmpdir(), process.env.WOX_RADIO_MPV || "mpv")
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Playback timed out")), 20000)
    player.onChange = state => {
      if (state.status === "playing") {
        clearTimeout(timer)
        resolve()
      }
      if (state.status === "error") {
        clearTimeout(timer)
        reject(new Error(state.error))
      }
    }
  })
  try {
    await Promise.all([player.play(station), ready])
    await player.setPaused(true)
    if (player.state.status !== "paused") throw new Error("Pause was not reflected")
    await player.setVolume(25)
    await player.setPaused(false)
    if (player.state.status !== "playing" || player.state.volume !== 25) throw new Error("Playback state did not update")
    console.log(`Playback and IPC controls passed: ${station.name}`)
  } finally {
    player.stop()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
