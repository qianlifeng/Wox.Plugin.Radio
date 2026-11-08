import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { chmod, mkdir, open, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { release } from "node:os"
import { promisify } from "node:util"
import { RadioError, RadioMessage } from "./i18n"

const exec = promisify(execFile)
const official = "https://github.com/mpv-player/mpv/releases/download/v0.42.0/"
const linux = "https://github.com/pkgforge-dev/mpv-AppImage/releases/download/v0.42.0%402026-11-07_1794059289/"
type Package = { url: string; sha256: string; kind: "windows" | "macos" | "linux" }
const packages: Record<string, Package> = {
  "win32-x64": { url: official + "mpv-v0.42.0-x86_64-pc-windows-msvc.zip", sha256: "8dd69cbab079086765fa5d873c09513b2834b85d146c1301718a757e8c0595ef", kind: "windows" },
  "win32-arm64": { url: official + "mpv-v0.42.0-aarch64-pc-windows-msvc.zip", sha256: "8e7d12a532dea783d891ee97eeee2c3c052be71e5644abad6dffb615396c035d", kind: "windows" },
  "darwin-x64": { url: official + "mpv-v0.42.0-macos-15-intel.zip", sha256: "2d2f34350ff844b6014c35f21ca142937275e19c0c673150a8564fcd2f3bfa14", kind: "macos" },
  "darwin-arm64": { url: official + "mpv-v0.42.0-macos-15-arm.zip", sha256: "be1b8d2445e6880860869c080b8710dee189721f1fa4689840db6a2c10d7be69", kind: "macos" },
  "linux-x64": { url: linux + "mpv-v0.42.0-anylinux-x86_64.AppImage", sha256: "c9c367a4038e85b8061ecf974521f56692f68df06f3b2cc37990ab1f43ed6203", kind: "linux" },
  "linux-arm64": { url: linux + "mpv-v0.42.0-anylinux-aarch64.AppImage", sha256: "0926e601e37f5fcba21f85f1440dedb9c664e19f898a7cfc938fa4d36d24e851", kind: "linux" }
}

export function unsupportedReason(platform: string, arch: string, kernelRelease: string): RadioMessage | undefined {
  if (!packages[`${platform}-${arch}`]) return { key: "install_platform", values: { platform, arch } }
  if (platform === "darwin" && Number.parseInt(kernelRelease, 10) < 24) return { key: "install_macos" }
  return undefined
}

function executable(dir: string, kind: Package["kind"]): string {
  return join(dir, kind === "windows" ? "mpv.exe" : kind === "macos" ? "mpv.app/Contents/MacOS/mpv" : "squashfs-root/AppRun")
}
export function playerEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" }
}

async function works(path: string): Promise<boolean> {
  try {
    await exec(path, ["--version"], { timeout: 10000, windowsHide: true, env: playerEnvironment() })
    return true
  } catch {
    return false
  }
}

export class MpvInstaller {
  private installation?: Promise<string>
  private readonly pkg = packages[`${process.platform}-${process.arch}`]
  private readonly target: string

  constructor(private readonly cache: string) {
    this.target = join(cache, "mpv-v0.42.0")
  }

  unavailableReason(): RadioMessage | undefined {
    return unsupportedReason(process.platform, process.arch, release())
  }

  async find(): Promise<string | undefined> {
    const cached = this.pkg && executable(this.target, this.pkg.kind)
    if (cached && (await works(cached))) return cached
    return (await works("mpv")) ? "mpv" : undefined
  }

  install(progress: (message: RadioMessage) => void): Promise<string> {
    if (!this.installation) this.installation = this.download(progress).finally(() => { this.installation = undefined })
    return this.installation
  }

  private async download(progress: (message: RadioMessage) => void): Promise<string> {
    const pkg = this.pkg
    const reason = this.unavailableReason()
    if (reason || !pkg) throw new RadioError(reason?.key ?? "install_unavailable", reason?.values)
    if (!this.cache) throw new RadioError("cache_unavailable")
    const temp = join(this.cache, `mpv-download-${randomUUID()}`)
    await mkdir(temp, { recursive: true })
    try {
      progress({ key: "download_connecting" })
      const response = await fetch(pkg.url, { headers: { "User-Agent": "Wox.Plugin.Radio/0.0.8" }, signal: AbortSignal.timeout(300000) })
      if (!response.ok || !response.body) throw new RadioError("download_http", { code: String(response.status) })
      const total = Number(response.headers.get("content-length")) || 0
      const archive = join(temp, pkg.kind === "linux" ? "mpv.AppImage" : "mpv.zip")
      const file = await open(archive, "w")
      const hash = createHash("sha256")
      let received = 0
      let last = -1
      try {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received += value.length
          if (received > 150 * 1024 * 1024) throw new RadioError("download_too_large")
          hash.update(value)
          await file.writeFile(value)
          const amount = total ? Math.min(100, Math.floor((received / total) * 20) * 5) : Math.round(received / 1048576)
          if (amount !== last) {
            last = amount
            progress(total ? { key: "download_percent", values: { percent: `${amount}%` } } : { key: "download_size", values: { size: amount } })
          }
        }
      } finally {
        await file.close()
      }
      if (hash.digest("hex") !== pkg.sha256) throw new RadioError("download_checksum")
      progress({ key: "install_progress" })
      if (pkg.kind === "windows") {
        const tar = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
        await exec(tar, ["-xf", archive, "-C", temp, "mpv.exe"], { timeout: 60000, windowsHide: true })
      } else if (pkg.kind === "macos") {
        await exec("/usr/bin/ditto", ["-x", "-k", archive, temp], { timeout: 60000 })
        await exec("/usr/bin/tar", ["-xzf", join(temp, "mpv.tar.gz"), "-C", temp], { timeout: 60000 })
      } else {
        await chmod(archive, 0o755)
        await exec(archive, ["--appimage-extract"], { cwd: temp, timeout: 60000, maxBuffer: 10 * 1024 * 1024 })
      }
      const candidate = executable(temp, pkg.kind)
      if (!(await works(candidate))) throw new RadioError("install_start_failed")
      await rm(archive, { force: true })
      if (pkg.kind === "macos") await rm(join(temp, "mpv.tar.gz"), { force: true })
      await rm(this.target, { recursive: true, force: true })
      await rename(temp, this.target)
      return executable(this.target, pkg.kind)
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  }
}
