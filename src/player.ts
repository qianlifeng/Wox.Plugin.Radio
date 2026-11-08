import { spawn, ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { Socket, createConnection } from "node:net"
import { join } from "node:path"
import { Station } from "./directory"
import { RadioMessage } from "./i18n"
import { readSpectrum, spectrumFilter } from "./spectrum"

export type PlaybackStatus = "stopped" | "connecting" | "playing" | "paused" | "error"
export interface PlaybackState {
  station?: Station
  status: PlaybackStatus
  volume: number
  error?: RadioMessage
  tune?: { id: number; startedAt: number }
  spectrum?: number[]
}

// The audio process belongs to the plugin, not the launcher preview.
export class RadioPlayer {
  state: PlaybackState = { status: "stopped", volume: 70 }
  onChange: (state: PlaybackState) => void = () => {}
  onSpectrum: () => void = () => {}
  private child?: ChildProcess
  private socket?: Socket
  private socketPath = ""
  private socketDirectory = ""
  private generation = 0
  private pending = new Map<number, (error: Error | undefined) => void>()
  private nextID = 0

  constructor(
    private readonly cacheFolder: string,
    private executable = "mpv"
  ) {}

  setExecutable(executable: string): void {
    this.executable = executable
  }

  private publish(patch: Partial<PlaybackState>): void {
    this.state = { ...this.state, ...patch }
    this.onChange({ ...this.state })
  }

  async play(station: Station): Promise<void> {
    if (!/^https?:\/\//i.test(station.url_resolved)) throw new Error("Invalid stream URL")
    this.stopProcess()
    const generation = ++this.generation
    const name = `wox-radio-${randomUUID()}`
    if (process.platform !== "win32" && !this.cacheFolder) {
      this.publish({ station, status: "error", error: { key: "cache_unavailable" } })
      return
    }
    this.publish({ station, status: "connecting", error: undefined, spectrum: undefined, tune: { id: generation, startedAt: Date.now() } })
    if (process.platform === "win32") {
      this.socketPath = `\\\\.\\pipe\\${name}`
    } else {
      // macOS limits Unix socket paths to 103 bytes; the plugin cache path can
      // exceed that even before a socket filename is appended. A private short
      // temporary directory also keeps other users from connecting to mpv.
      let directory: string
      try {
        directory = await mkdtemp("/tmp/wox-radio-")
      } catch (error) {
        this.fail(generation, { key: "player_start_failed", values: { error: error instanceof Error ? error.message : String(error) } })
        return
      }
      if (generation !== this.generation) {
        void rm(directory, { recursive: true, force: true }).catch(() => {})
        return
      }
      this.socketDirectory = directory
      this.socketPath = join(directory, "mpv.sock")
    }
    const child = spawn(
      this.executable,
      ["--no-config", "--no-terminal", "--no-video", "--force-window=no", `--volume=${this.state.volume}`, `--input-ipc-server=${this.socketPath}`, "--", station.url_resolved],
      {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" }
      }
    )
    this.child = child
    let lastFrame = 0
    if (child.stdout) {
      readSpectrum(child.stdout, spectrum => {
        if (generation !== this.generation || this.state.status !== "playing") return
        const now = Date.now()
        if (now - lastFrame < 80) return
        lastFrame = now
        this.state = { ...this.state, spectrum }
        this.onSpectrum()
      })
    }
    child.once("error", error => this.fail(generation, { key: "player_start_failed", values: { error: error.message } }))
    child.once("exit", (code, signal) => {
      if (generation === this.generation && this.child === child) {
        const reason = signal || (code ? String(code) : "")
        this.fail(generation, reason ? { key: "playback_stopped", values: { error: reason } } : { key: "stream_ended" })
      }
    })
    const deadline = Date.now() + 8000
    while (generation === this.generation && Date.now() < deadline) {
      let socket: Socket
      try {
        socket = await this.connect(this.socketPath)
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100))
        continue
      }
      if (generation !== this.generation) {
        socket.destroy()
        return
      }
      this.socket = socket
      this.listen(socket, generation)
      try {
        // A short stream may have started before the IPC connection was ready.
        await this.command(["observe_property", 1, "core-idle"])
        await this.command(["set_property", "volume", this.state.volume])
        // A custom mpv build may omit these filters. Audio playback still works.
        if (generation === this.generation) void this.command(["af", "add", `@wox-spectrum:lavfi=[${spectrumFilter}]`]).catch(() => {})
      } catch (error) {
        this.fail(generation, { key: "player_setup_failed", values: { error: error instanceof Error ? error.message : String(error) } })
      }
      return
    }
    if (generation === this.generation) this.fail(generation, { key: "player_no_connection" })
  }

  private connect(path: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path)
      socket.once("error", reject)
      socket.once("connect", () => {
        socket.removeListener("error", reject)
        resolve(socket)
      })
    })
  }

  private listen(socket: Socket, generation: number): void {
    let buffer = ""
    socket.on("data", data => {
      buffer += data.toString()
      for (;;) {
        const newline = buffer.indexOf("\n")
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try {
          const event = JSON.parse(line)
          if (generation !== this.generation) return
          if (event.request_id) {
            const resolve = this.pending.get(event.request_id)
            this.pending.delete(event.request_id)
            resolve?.(event.error === "success" ? undefined : new Error(String(event.error)))
          } else if (event.event === "playback-restart" || (event.event === "property-change" && event.name === "core-idle" && event.data === false)) {
            if (this.state.status === "connecting") this.publish({ status: "playing" })
          } else if (event.event === "end-file" && event.reason === "error") {
            this.fail(generation, event.file_error ? { key: "stream_failed", values: { error: String(event.file_error) } } : { key: "stream_unavailable" })
          }
        } catch {
          /* Ignore malformed IPC messages. */
        }
      }
    })
    socket.on("error", error => this.fail(generation, { key: "player_connection_failed", values: { error: error.message } }))
    socket.on("close", () => {
      if (generation === this.generation) this.fail(generation, { key: "player_connection_closed" })
    })
  }

  private command(command: (string | number | boolean)[]): Promise<void> {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error("Player is not connected"))
    const id = ++this.nextID
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error("Player command timed out"))
      }, 3000)
      this.pending.set(id, error => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      })
      this.socket!.write(`${JSON.stringify({ command, request_id: id })}\n`)
    })
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.command(["set_property", "pause", paused])
    this.publish({ status: paused ? "paused" : "playing", spectrum: undefined })
  }

  async setVolume(volume: number): Promise<void> {
    if (!Number.isFinite(volume)) throw new Error("Volume must be a finite number")
    const value = Math.max(0, Math.min(100, Math.round(volume)))
    if (this.socket) await this.command(["set_property", "volume", value])
    this.publish({ volume: value })
  }

  stop(): void {
    this.stopProcess()
    ++this.generation
    this.publish({ status: "stopped", error: undefined, tune: undefined, spectrum: undefined })
  }

  private fail(generation: number, error: RadioMessage): void {
    if (generation !== this.generation) return
    this.stopProcess()
    ++this.generation
    this.publish({ status: "error", error, spectrum: undefined })
  }

  private stopProcess(): void {
    const socket = this.socket
    this.socket = undefined
    socket?.destroy()
    const child = this.child
    this.child = undefined
    child?.kill()
    for (const done of this.pending.values()) done(new Error("Player stopped"))
    this.pending.clear()
    this.socketPath = ""
    const directory = this.socketDirectory
    this.socketDirectory = ""
    if (directory) void rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}
