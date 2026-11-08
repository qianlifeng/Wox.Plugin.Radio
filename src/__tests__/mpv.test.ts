import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MpvInstaller, unsupportedReason } from "../mpv"

test("automatic installation checks OS, architecture and macOS version", () => {
  expect(unsupportedReason("darwin", "arm64", "24.1.0")).toBeUndefined()
  expect(unsupportedReason("darwin", "x64", "23.5.0")).toEqual({ key: "install_macos" })
  expect(unsupportedReason("linux", "x64", "6.8.0")).toBeUndefined()
  expect(unsupportedReason("linux", "arm64", "6.8.0")).toBeUndefined()
  expect(unsupportedReason("win32", "ia32", "10.0.0")).toEqual({ key: "install_platform", values: { platform: "win32", arch: "ia32" } })
})

test("a corrupt download is rejected, cleaned up, and can be retried", async () => {
  const folder = await mkdtemp(join(tmpdir(), "wox-radio-test-"))
  const original = global.fetch
  const mock = jest.fn().mockImplementation(async () => new Response("not an mpv archive", { headers: { "content-length": "18" } }))
  global.fetch = mock
  try {
    const installer = new MpvInstaller(folder)
    const progress = jest.fn()
    const first = installer.install(progress)
    const duplicate = installer.install(progress)
    expect(first).toBe(duplicate)
    await expect(first).rejects.toThrow("SHA-256")
    expect(progress).toHaveBeenCalledWith({ key: "download_percent", values: { percent: "100%" } })
    expect(await readdir(folder)).toEqual([])
    await expect(installer.install(progress)).rejects.toThrow("SHA-256")
    expect(mock).toHaveBeenCalledTimes(2)
  } finally {
    global.fetch = original
    await rm(folder, { recursive: true, force: true })
  }
})
