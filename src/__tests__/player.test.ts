import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { RadioPlayer } from "../player"
import { Station } from "../directory"

jest.mock("node:child_process", () => ({ spawn: jest.fn() }))
jest.mock("node:net", () => ({ createConnection: jest.fn() }))
import { spawn } from "node:child_process"
import { createConnection } from "node:net"

const station: Station = {
  stationuuid: "one",
  name: "Radio",
  url_resolved: "https://example.com/stream",
  countrycode: "JP",
  country: "Japan",
  language: "japanese",
  tags: "jazz",
  bitrate: 128,
  favicon: ""
}

test("player keeps playback independent and uses IPC for pause and volume", async () => {
  const stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), { kill: jest.fn(), stdout })
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    destroy: jest.fn(),
    write: jest.fn((line: string) => {
      const request = JSON.parse(line)
      process.nextTick(() => socket.emit("data", Buffer.from(JSON.stringify({ request_id: request.request_id, error: "success" }) + "\n")))
      return true
    })
  })
  jest.mocked(spawn).mockReturnValue(child as never)
  jest.mocked(createConnection).mockImplementation((() => {
    process.nextTick(() => socket.emit("connect"))
    return socket
  }) as never)
  const player = new RadioPlayer("cache")
  player.onSpectrum = jest.fn()
  await player.play(station)
  expect(player.state.status).toBe("connecting")
  socket.emit("data", Buffer.from('{"event":"playback-restart"}\n'))
  expect(player.state.status).toBe("playing")
  stdout.write("frame:0\n")
  for (const [index, level] of ["-11", "-14", "-inf", "-inf", "-inf", "-inf", "-inf", "-inf"].entries()) {
    stdout.write(`lavfi.astats.${index + 1}.RMS_level=${level}\n`)
  }
  expect(player.onSpectrum).toHaveBeenCalledTimes(1)
  const levels = player.state.spectrum!
  expect(levels[0]).toBeLessThan(1)
  expect(levels[0]).toBeGreaterThan(levels[1])
  expect(levels[2]).toBe(0)
  await player.setPaused(true)
  await player.setVolume(150)
  expect(player.state.status).toBe("paused")
  expect(player.state.spectrum).toBeUndefined()
  expect(player.state.volume).toBe(100)
  expect(socket.write.mock.calls.map(([value]) => JSON.parse(value).command)).toContainEqual(["set_property", "pause", true])
  expect(socket.write.mock.calls.map(([value]) => JSON.parse(value).command)).toContainEqual(["set_property", "volume", 100])
  player.stop()
  stdout.end()
  expect(child.kill).toHaveBeenCalledTimes(1)
  expect(player.state.status).toBe("stopped")
})

test("invalid stream schemes are rejected", async () => {
  const player = new RadioPlayer("cache")
  await expect(player.play({ ...station, url_resolved: "file:///private" })).rejects.toThrow("Invalid stream URL")
})
