import { Context, PublicAPI, Query, QueryResponse } from "@wox-launcher/wox-plugin"
import { plugin } from "../index"
import { Station } from "../directory"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RadioPlayer } from "../player"
import { MpvInstaller } from "../mpv"
import { PlayerViewPreview } from "../playerView"
import { RadioMessage } from "../i18n"

jest.mock("../player")
jest.mock("../mpv")

const station: Station = {
  stationuuid: "one",
  name: "Jazz Radio",
  url_resolved: "https://example.com/audio",
  country: "Japan",
  countrycode: "JP",
  language: "japanese",
  tags: "jazz",
  bitrate: 128,
  favicon: ""
}
const ctx = { Get: (key: string) => (key === "SessionId" ? "session" : undefined) } as Context
const query = (search: string, refinements: Record<string, string> = {}) => ({ Id: "query", SessionId: "session", Search: search, Refinements: refinements }) as Query
const api = {
  GetCacheFolder: jest.fn().mockResolvedValue("cache"),
  GetSetting: jest.fn().mockResolvedValue(""),
  GetTranslation: jest.fn().mockResolvedValue("en-US"),
  SaveSetting: jest.fn().mockResolvedValue(undefined),
  OnLeavePluginQuery: jest.fn().mockResolvedValue(undefined),
  OnUnload: jest.fn().mockResolvedValue(undefined),
  Notify: jest.fn().mockResolvedValue(undefined),
  ChangeQuery: jest.fn().mockResolvedValue(undefined),
  RefreshQuery: jest.fn().mockResolvedValue(undefined),
  Log: jest.fn().mockResolvedValue(undefined),
  UpdateResult: jest.fn().mockResolvedValue(true),
  UpdatePluginPreview: jest.fn().mockResolvedValue({ Success: true })
} as unknown as PublicAPI & { UpdatePluginPreview: jest.Mock }

const outside = { ...station, stationuuid: "france", countrycode: "FR", country: "France" }
let cacheFolder: string
beforeEach(async () => {
  cacheFolder = await mkdtemp(join(tmpdir(), "radio-catalog-"))
  jest.mocked(api.GetCacheFolder).mockResolvedValue(cacheFolder)
  jest.mocked(api.GetSetting).mockResolvedValue("")
  jest.mocked(api.GetTranslation).mockResolvedValue("en-US")
  jest.mocked(MpvInstaller).mockImplementation(() => ({ find: jest.fn().mockResolvedValue("mpv"), install: jest.fn(), unavailableReason: jest.fn() }) as unknown as MpvInstaller)
})

afterEach(async () => {
  const calls = jest.mocked(api.OnUnload).mock.calls
  await calls[calls.length - 1]?.[1](ctx)
  await rm(cacheFolder, { recursive: true, force: true })
})

test("query returns radio controls, filters and one persistent plugin preview", async () => {
  await writeFile(join(cacheFolder, "stations-v1.json"), JSON.stringify({ updatedAt: Date.now(), stations: [station, outside] }))
  jest
    .mocked(RadioPlayer)
    .mockImplementation(() => ({ state: { status: "stopped", volume: 70 }, play: jest.fn(), stop: jest.fn(), setExecutable: jest.fn(), onChange: () => {} }) as unknown as RadioPlayer)
  await plugin.init(ctx, { API: api, PluginDirectory: "" })
  const first = (await plugin.query(ctx, query("jazz", { genre: "jazz", country: "JP" }))) as QueryResponse & { PluginPreview: { WoxViewID: string } }
  expect(first.Results.map(item => item.Title)).toEqual(expect.arrayContaining(["Next station", "Explore elsewhere", "Genre: jazz", "Jazz Radio"]))
  const genreAction = first.Results.find(item => item.Title === "Genre: jazz")?.Actions?.[0]
  if (!genreAction || genreAction.Type === "form") throw new Error("Missing category action")
  await genreAction.Action(ctx, { ResultId: "category", ResultActionId: "filter", ContextData: {} })
  expect(api.ChangeQuery).toHaveBeenCalledWith(ctx, expect.objectContaining({ QueryText: "radio ", ContextData: expect.objectContaining({ radio_genre: "jazz", radio_country: "JP" }) }))
  const modifier = process.platform === "darwin" ? "cmd" : "ctrl"
  expect(first.Refinements?.map(item => [item.Id, item.Hotkey, item.Type, item.Options.length])).toEqual([
    ["genre", `${modifier}+g`, "singleSelect", 2],
    ["country", `${modifier}+r`, "singleSelect", 3],
    ["language", `${modifier}+l`, "singleSelect", 2]
  ])
  expect(first.Refinements?.find(item => item.Id === "country")?.Options).toContainEqual({ Value: "FR", Title: "France", Keywords: ["法国"], Count: 1 })
  expect(first.PluginPreview.WoxViewID).toBeTruthy()
  const second = (await plugin.query(ctx, query("other", { genre: "jazz", country: "JP" }))) as QueryResponse & { PluginPreview: { WoxViewID: string } }
  expect(second.PluginPreview.WoxViewID).toBe(first.PluginPreview.WoxViewID)
  const categoryQuery = { ...query(""), ContextData: { radio_genre: "jazz", radio_country: "JP" } } as Query
  const filtered = (await plugin.query(ctx, categoryQuery)) as QueryResponse
  expect(filtered.Refinements?.find(item => item.Id === "genre")?.DefaultValue).toEqual(["jazz"])
  expect(filtered.Refinements?.find(item => item.Id === "country")?.DefaultValue).toEqual(["JP"])
  const action = first.Results.find(item => item.Title === "Jazz Radio")?.Actions?.[0]
  if (!action || action.Type === "form") throw new Error("Missing station action")
  await action.Action(ctx, { ResultId: "station:one", ResultActionId: "play", ContextData: {} })
  expect(jest.mocked(RadioPlayer).mock.results[0].value.play).toHaveBeenCalledWith(station)
  const instance = jest.mocked(RadioPlayer).mock.results[0].value as RadioPlayer
  instance.state = { station, status: "playing", volume: 70 }
  instance.onChange(instance.state)
  expect(api.UpdateResult).toHaveBeenCalledWith(ctx, { Id: "station:one", Tails: [{ Type: "text", Text: "Playing" }] })
  const next = first.Results.find(item => item.Id === "next")?.Actions?.[0]
  const explore = first.Results.find(item => item.Id === "explore")?.Actions?.[0]
  if (!next || next.Type === "form" || !explore || explore.Type === "form") throw new Error("Missing quick actions")
  await next.Action(ctx, { ResultId: "next", ResultActionId: "play", ContextData: {} })
  expect(jest.mocked(RadioPlayer).mock.results[0].value.play).toHaveBeenLastCalledWith(station)
  await explore.Action(ctx, { ResultId: "explore", ResultActionId: "play", ContextData: {} })
  expect(jest.mocked(RadioPlayer).mock.results[0].value.play).toHaveBeenLastCalledWith(outside)

  const changed = (await plugin.query(ctx, { ...query("jazz", { genre: "jazz", country: "FR" }), ContextData: categoryQuery.ContextData })) as QueryResponse
  expect(changed.Results.find(item => item.Id === "next")?.SubTitle).toBe("Another station in jazz · France")
  const cleared = (await plugin.query(ctx, { ...query("jazz", { genre: "jazz", country: "all" }), ContextData: categoryQuery.ContextData })) as QueryResponse
  expect(cleared.Results.find(item => item.Id === "next")?.SubTitle).toBe("Another station in jazz")
})

test("a missing player offers localized installation and progress", async () => {
  jest.mocked(api.GetTranslation).mockResolvedValue("zh-CN")
  const install = jest.fn(async (progress: (message: RadioMessage) => void) => {
    progress({ key: "download_percent", values: { percent: "42%" } })
    return "cache/mpv/mpv.exe"
  })
  jest.mocked(MpvInstaller).mockImplementation(() => ({ find: jest.fn().mockResolvedValue(undefined), install, unavailableReason: jest.fn() }) as unknown as MpvInstaller)
  jest.mocked(RadioPlayer).mockImplementation(() => ({ state: { status: "stopped", volume: 70 }, setExecutable: jest.fn(), stop: jest.fn(), onChange: () => {} }) as unknown as RadioPlayer)
  await plugin.init(ctx, { API: api, PluginDirectory: "" })
  const response = (await plugin.query(ctx, query(""))) as QueryResponse
  const result = response.Results.find(item => item.Id === "install-mpv")
  expect(response.Results).toHaveLength(1)
  expect((response as QueryResponse & { PluginPreview?: unknown }).PluginPreview).toBeUndefined()
  expect(response.Refinements).toBeUndefined()
  expect(result?.Title).toBe("安装 mpv 以收听电台")
  expect(result?.Group).toBeUndefined()
  const action = result?.Actions?.[0]
  if (!action || action.Type === "form") throw new Error("Missing install action")
  await action.Action(ctx, { ResultId: "install-mpv", ResultActionId: "install", ContextData: {} })
  await new Promise(resolve => setImmediate(resolve))
  expect(api.UpdateResult).toHaveBeenCalledWith(ctx, { Id: "install-mpv", SubTitle: "正在下载 mpv · 42%" })
  const calls = jest.mocked(RadioPlayer).mock.results
  expect(calls[calls.length - 1].value.setExecutable).toHaveBeenCalledWith("cache/mpv/mpv.exe")
  expect(api.RefreshQuery).toHaveBeenCalled()
  const next = (await plugin.query(ctx, query(""))) as QueryResponse
  expect(next.Results.some(item => item.Id === "install-mpv")).toBe(false)
})

test("Wox language changes update filters, saved stations and the existing player view", async () => {
  await writeFile(join(cacheFolder, "stations-v1.json"), JSON.stringify({ updatedAt: Date.now(), stations: [station] }))
  jest.mocked(api.GetSetting).mockImplementation(async (_ctx, key) => (key === "favorites" ? JSON.stringify([station]) : ""))
  jest.mocked(RadioPlayer).mockImplementation(() => ({ state: { station, status: "playing", volume: 70 }, stop: jest.fn(), setExecutable: jest.fn() }) as unknown as RadioPlayer)
  await plugin.init(ctx, { API: api, PluginDirectory: "" })
  const filters = { country: "JP", genre: "jazz", language: "japanese" }
  const runQuery = async (term = "") => (await plugin.query(ctx, query(term, filters))) as QueryResponse & { PluginPreview: PlayerViewPreview }
  const initial = await runQuery()
  expect(initial.Results[0].Title).toBe("Next station")
  await initial.PluginPreview.OnWoxViewEvent(ctx, { Type: "show" })
  await new Promise(resolve => setImmediate(resolve))
  jest.mocked(api.GetTranslation).mockResolvedValue("zh-CN")
  const localized = await runQuery()
  expect(localized.Results[0]).toMatchObject({ Title: "下一台", Group: "快速收听", SubTitle: "在「爵士 · 日本 · 日语」中换一台" })
  expect(localized.Results.find(result => result.Id === "station:one")).toMatchObject({ Title: station.name, Group: "收藏", SubTitle: "日本 · 爵士 · 128 kbps" })
  expect(localized.Refinements?.find(item => item.Id === "genre")?.Options).toContainEqual({ Value: "jazz", Title: "爵士", Keywords: ["jazz"], Count: 1 })
  expect(localized.PluginPreview.WoxViewID).toBe(initial.PluginPreview.WoxViewID)
  expect(api.UpdatePluginPreview).toHaveBeenLastCalledWith(ctx, expect.objectContaining({ Preview: expect.objectContaining({ PreviewData: expect.stringContaining("取消收藏") }) }))
  expect((await runQuery("爵士")).Results.find(item => item.Id === "category:genre:jazz")?.Title).toBe("类型：爵士")
})

test("the preview star refreshes matching favorites under the current search and filters", async () => {
  const playing = { ...station, tags: "jazz, ambient" }
  const saved = { ...playing, stationuuid: "saved" }
  await writeFile(join(cacheFolder, "stations-v1.json"), JSON.stringify({ updatedAt: Date.now(), stations: [playing, saved, outside] }))
  jest.mocked(api.GetSetting).mockImplementation(async (_ctx, key) => (key === "favorites" ? JSON.stringify([{ ...saved, tags: "news" }, outside]) : ""))
  jest.mocked(api.RefreshQuery).mockClear()
  jest.mocked(RadioPlayer).mockImplementation(() => ({ state: { station: playing, status: "playing", volume: 70 }, stop: jest.fn(), setExecutable: jest.fn() }) as unknown as RadioPlayer)
  await plugin.init(ctx, { API: api, PluginDirectory: "" })
  const filter = { genre: "jazz", country: "JP", language: "japanese" }
  const first = (await plugin.query(ctx, query("", filter))) as QueryResponse & { PluginPreview: PlayerViewPreview }
  const resultContext = { ...ctx }
  const active = query(" Ambient ", filter)
  const results = async () => ((await plugin.query(resultContext, active)) as QueryResponse).Results
  const groups = (items: QueryResponse["Results"], id: string) => items.filter(item => item.Id === `station:${id}`).map(item => item.Group)
  const before = await results()
  expect(groups(before, saved.stationuuid)).toEqual(["Favorites"])
  expect(groups(before, outside.stationuuid)).toEqual([])
  expect(groups(before, playing.stationuuid)).toEqual(["Stations"])

  await first.PluginPreview.OnWoxViewEvent(ctx, { Handler: "favorite" })
  expect(api.RefreshQuery).toHaveBeenNthCalledWith(1, resultContext, { PreserveSelectedIndex: true })
  expect(groups(await results(), playing.stationuuid)).toEqual(["Favorites"])

  await first.PluginPreview.OnWoxViewEvent(ctx, { Handler: "favorite" })
  expect(api.RefreshQuery).toHaveBeenNthCalledWith(2, resultContext, { PreserveSelectedIndex: true })
  expect(groups(await results(), playing.stationuuid)).toEqual(["Stations"])
})

test("a cold query immediately returns saved stations while the directory loads", async () => {
  jest.mocked(api.GetSetting).mockImplementation(async (_ctx, key) => (key === "favorites" ? JSON.stringify([station]) : ""))
  await plugin.init(ctx, { API: api, PluginDirectory: "" })
  const response = (await plugin.query(ctx, query("Jazz"))) as QueryResponse
  expect(response.Results.some(item => item.Title === "Jazz Radio" && item.Group === "Favorites")).toBe(true)
  expect(response.Results.some(item => item.Title === "Loading station directory…")).toBe(true)
})

test("station actions add and remove the selected station and preserve its selection", async () => {
  await writeFile(join(cacheFolder, "stations-v1.json"), JSON.stringify({ updatedAt: Date.now(), stations: [station, outside] }))
  jest.mocked(api.GetTranslation).mockResolvedValue("zh-CN")
  jest.mocked(api.SaveSetting).mockClear()
  jest.mocked(api.RefreshQuery).mockClear()
  const player = { state: { station: outside, status: "playing", volume: 70 }, play: jest.fn(), stop: jest.fn(), setExecutable: jest.fn() } as unknown as RadioPlayer
  jest.mocked(RadioPlayer).mockReturnValue(player)
  await plugin.init(ctx, { API: api, PluginDirectory: "" })
  const id = `station:${station.stationuuid}`
  const active = query("", { genre: "jazz", country: "JP" })
  const read = async () => {
    const response = (await plugin.query(ctx, active)) as QueryResponse & { PluginPreview: PlayerViewPreview }
    const row = response.Results.find(result => result.Id === id)
    const action = row?.Actions?.[1]
    if (!row || !action || action.Type === "form") throw new Error("Missing station favorite action")
    expect(row.Actions?.[0].Name).toBe("播放电台")
    expect(action.PreventHideAfterAction).toBe(true)
    return { row, action, preview: response.PluginPreview }
  }
  const actionContext = { ResultId: id, ResultActionId: "favorite", ContextData: {} }
  const before = await read()
  expect(before.action.Name).toBe("添加收藏")
  await Promise.all([before.action.Action(ctx, actionContext), before.action.Action(ctx, actionContext)])
  expect(api.SaveSetting).toHaveBeenCalledTimes(1)
  expect(api.SaveSetting).toHaveBeenLastCalledWith(ctx, "favorites", expect.any(String), false)
  expect(JSON.parse(jest.mocked(api.SaveSetting).mock.calls[0][2])).toEqual([station])
  expect(api.RefreshQuery).toHaveBeenLastCalledWith(ctx, { PreserveSelectedIndex: true, SelectedResultId: id })
  expect(player.play).not.toHaveBeenCalled()
  const added = await read()
  expect(added.row.Group).toBe("收藏")
  expect(added.action.Name).toBe("取消收藏")
  expect(added.preview.PreviewData).toContain("添加收藏")

  player.state = { station, status: "playing", volume: 70 }
  await added.preview.OnWoxViewEvent(ctx, { Type: "show" })
  await new Promise(resolve => setImmediate(resolve))
  expect(added.preview.PreviewData).toContain("取消收藏")
  await added.action.Action(ctx, actionContext)
  expect(api.SaveSetting).toHaveBeenLastCalledWith(ctx, "favorites", "[]", false)
  expect(api.UpdatePluginPreview).toHaveBeenLastCalledWith(ctx, expect.objectContaining({ Preview: expect.objectContaining({ PreviewData: expect.stringContaining("添加收藏") }) }))
  const removed = await read()
  expect(removed.row.Group).toBe("电台")
  expect(removed.action.Name).toBe("添加收藏")
})
