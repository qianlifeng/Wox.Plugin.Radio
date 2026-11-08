import { Readable } from "node:stream"
import { createInterface } from "node:readline"

const crossovers = [120, 240, 480, 960, 1900, 3800, 6500]
const bandCount = crossovers.length + 1
const labels = (prefix: string) => Array.from({ length: bandCount }, (_, index) => `[${prefix}${index}]`).join("")
const monoBands = Array.from({ length: bandCount }, (_, index) => `[b${index}]aformat=channel_layouts=mono[m${index}]`).join(";")

// Send the original audio to mpv unchanged. The side branch packs frequency bands
// into separate channels so astats reports one RMS value per band in each frame.
export const spectrumFilter = [
  "asplit[out][analysis]",
  `[analysis]aformat=channel_layouts=mono,aresample=22050,asetnsamples=n=2205:p=0,acrossover=split=${crossovers.join(" ")}:order=8th${labels("b")}`,
  monoBands,
  `${labels("m")}amerge=inputs=${bandCount},astats=metadata=1:reset=1:measure_perchannel=RMS_level:measure_overall=none,ametadata=mode=print:file='pipe\\:1':direct=1,anullsink`
].join(";")

export function readSpectrum(stream: Readable, onFrame: (levels: number[]) => void): void {
  let decibels: number[] = []
  let ceiling = -24
  createInterface({ input: stream, crlfDelay: Infinity }).on("line", line => {
    if (line.startsWith("frame:")) {
      decibels = []
      return
    }
    const match = /^lavfi\.astats\.(\d+)\.RMS_level=(.+)$/.exec(line)
    if (!match || Number(match[1]) !== decibels.length + 1 || decibels.length >= bandCount) return
    const value = Number(match[2])
    decibels.push(Number.isFinite(value) ? value : -Infinity)
    if (decibels.length !== bandCount) return

    // Track loud stations quickly and release slowly so peaks have room without gain pumping.
    ceiling = Math.max(-24, Math.max(...decibels) + 7, ceiling - 0.55)
    onFrame(decibels.map(db => Math.pow(Math.max(0, (db + 66) / (ceiling + 66)), 1.65)))
  })
}
