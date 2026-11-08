// Run after bundling to check the real directory and plugin response.
const { plugin } = require("../dist/index.js")
const { tmpdir } = require("node:os")
const { mkdtemp, rm } = require("node:fs/promises")
const { join } = require("node:path")
const assert = require("node:assert/strict")

const ctx = { Get: key => key === "SessionId" ? "smoke" : undefined }
let folder
let unload
let refreshed
const api = {
  GetCacheFolder: async () => folder, GetSetting: async () => "", GetTranslation: async () => "en-US", SaveSetting: async () => {},
  OnLeavePluginQuery: async () => {}, OnUnload: async (_ctx, callback) => { unload = callback }, Log: async () => {},
  Notify: async () => {}, UpdatePluginPreview: async () => ({ Success: true }),
  RefreshQuery: async () => { refreshed?.() }
}

async function main() {
  folder = await mkdtemp(join(tmpdir(), "wox-radio-smoke-"))
  let timer
  try {
    await plugin.init(ctx, { API: api, PluginDirectory: "" })
    const query = { Id: "smoke", SessionId: "smoke", Search: "jazz" }
    const cold = await plugin.query(ctx, query)
    assert.equal(cold.PluginPreview.PreviewType, "woxview")
    assert.ok(cold.Results.some(result => result.Id === "directory-status"))
    await new Promise((resolve, reject) => {
      refreshed = resolve
      timer = setTimeout(() => reject(new Error("Station directory did not refresh")), 20000)
    })
    const response = await plugin.query(ctx, query)
    assert.equal(response.PluginPreview.WoxViewID, cold.PluginPreview.WoxViewID)
    assert.ok(response.Results.some(result => result.Id?.startsWith("station:")), "no stations returned")
    assert.equal(response.Refinements.length, 3)
    console.log("Cold query returned immediately and was refreshed when stations arrived")
  } finally {
    clearTimeout(timer)
    await unload?.(ctx)
    await rm(folder, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
