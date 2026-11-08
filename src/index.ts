import { Context, Plugin, PublicAPI, Query, QueryRefinement, QueryRefinementOption, QueryResponse, Result, ResultTail } from "@wox-launcher/wox-plugin"
import { Categories, chooseStation, DirectoryCategory, matchesFilter, matchesSavedStation, Station, StationCatalog, StationFilter } from "./directory"
import { english, RadioError, RadioLocale, radioLocale, RadioMessage } from "./i18n"
import { RadioPlayer } from "./player"
import { MpvInstaller } from "./mpv"
import { createPlayerView, PlayerViewPreview } from "./playerView"

type PreviewAPI = PublicAPI & {
  UpdatePluginPreview(ctx: Context, option: { Preview: PlayerViewPreview }): Promise<{ Success: boolean }>
  UpdatePluginPreviewData?(ctx: Context, option: { WoxViewID: string; WoxViewNodeKey: string; WoxViewData: { pointRadii: number[] } }): Promise<{ Success: boolean }>
}
type Session = { filter: StationFilter; locale: RadioLocale; view: ReturnType<typeof createPlayerView>; resultContext?: Context; resultIDs?: Set<string>; marked?: string }
const filterGroups = [
  { id: "genre", field: "tags", key: "g" },
  { id: "country", field: "countries", key: "r" },
  { id: "language", field: "languages", key: "l" }
] as const
type FilterGroup = (typeof filterGroups)[number]
const chinese = radioLocale("zh-CN")
const refinementOptions = new WeakMap<Categories, WeakMap<RadioLocale, QueryRefinementOption[][]>>()
const icon = { ImageType: "relative" as const, ImageData: "images/radio.png" }
const nextIcon = {
  ImageType: "svg" as const,
  ImageData:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M5 4v16l11-8zM19 5v14" fill="none" stroke="var(--wox-theme-icon-color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
}
const randomIcon = {
  ImageType: "svg" as const,
  ImageData:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 6h3c5 0 5 12 10 12h3m-3-3 3 3-3 3M4 18h3c2 0 3-2 4-4m3-4c1-2 2-4 4-4h2m-3-3 3 3-3 3" fill="none" stroke="var(--wox-theme-icon-color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
}
const addFavoriteIcon = {
  ImageType: "svg" as const,
  ImageData:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="var(--wox-theme-icon-color)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.6 5.4 6 .9-4.3 4.2 1 5.9L12 16.8 6.7 19.4l1-5.9L3.4 9.3l6-.9z"/></svg>'
}
const removeFavoriteIcon = {
  ImageType: "svg" as const,
  ImageData:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="var(--wox-theme-icon-color)" d="M12 2.5 15 8.7l6.8 1-4.9 4.8 1.2 6.8-6.1-3.2-6.1 3.2 1.2-6.8-4.9-4.8 6.8-1z"/></svg>'
}
let api: PreviewAPI
let player: RadioPlayer
let installer: MpvInstaller
let mpvReady = false
let installMessage: RadioMessage = { key: "install_prompt" }
let favorites: Station[] = []
let favoriteUpdates = Promise.resolve()
let recent: Station[] = []
let catalog: StationCatalog
const sessions = new Map<string, Session>()

function showInstallProgress(message: RadioMessage): void {
  installMessage = message
  for (const session of sessions.values()) {
    if (session.resultContext && session.resultIDs?.has("install-mpv")) {
      void api.UpdateResult(session.resultContext, { Id: "install-mpv", SubTitle: session.locale.t(message.key, message.values) }).catch(() => {})
    }
  }
}

async function installMpv(): Promise<void> {
  try {
    const reason = installer.unavailableReason()
    const path = reason ? await installer.find() : await installer.install(showInstallProgress)
    if (!path) {
      showInstallProgress({ key: "install_manual_hint", values: { reason: reason ?? { key: "install_unavailable" } } })
      return
    }
    player.setExecutable(path)
    mpvReady = true
    showInstallProgress({ key: "install_ready" })
    for (const session of sessions.values()) {
      if (session.resultContext) void api.RefreshQuery(session.resultContext, { PreserveSelectedIndex: false }).catch(() => {})
    }
  } catch (error) {
    const detail: RadioMessage = error instanceof RadioError ? error.notice : { key: "install_failed", values: { error: error instanceof Error ? error.message : String(error) } }
    showInstallProgress({ key: "install_retry", values: { error: detail } })
  }
}

function installResult(locale: RadioLocale): Result {
  const reason = installer.unavailableReason()
  return {
    Id: "install-mpv",
    Title: locale.t(reason ? "install_manual_title" : "install_title"),
    SubTitle: reason ? locale.t("install_manual_hint", { reason }) : locale.t(installMessage.key, installMessage.values),
    Icon: icon,
    Score: 1000,
    Actions: [
      {
        Name: locale.t(reason ? "install_recheck" : "install_action"),
        PreventHideAfterAction: true,
        Action: async () => {
          void installMpv()
        }
      }
    ]
  }
}

function parseStations(value: string): Station[] {
  try {
    const data: unknown = JSON.parse(value)
    return Array.isArray(data) ? data.filter(item => item && typeof item.stationuuid === "string" && typeof item.url_resolved === "string").slice(0, 100) : []
  } catch {
    return []
  }
}
function updateViews(): void {
  for (const session of sessions.values()) {
    session.view.refresh()
    if (!session.resultContext || !session.resultIDs) continue
    const current = player.state.station ? `station:${player.state.station.stationuuid}` : ""
    for (const id of new Set([session.marked || "", current])) {
      if (id && session.resultIDs.has(id)) {
        void api.UpdateResult(session.resultContext, { Id: id, Tails: id === current ? playingTail(session.locale) : [] }).catch(error => api.Log(session.resultContext!, "Error", String(error)))
      }
    }
    session.marked = current
  }
}
function playingTail(locale: RadioLocale): ResultTail[] {
  const labels = { playing: "tail_playing", paused: "tail_paused", connecting: "tail_connecting", error: "tail_unavailable", stopped: "" } as const
  const label = labels[player.state.status]
  return label ? [{ Type: "text", Text: locale.t(label) }] : []
}
async function saveList(ctx: Context, key: string, list: Station[]): Promise<void> {
  await api.SaveSetting(ctx, key, JSON.stringify(list), false)
}
async function playStation(ctx: Context, station: Station): Promise<void> {
  recent = [station, ...recent.filter(item => item.stationuuid !== station.stationuuid)].slice(0, 20)
  const saving = saveList(ctx, "recent", recent).catch(error => api.Log(ctx, "Error", `Unable to save recently played stations: ${String(error)}`))
  await Promise.all([player.play(station), saving])
}
function isFavorite(station: Station | undefined): boolean {
  return favorites.some(item => item.stationuuid === station?.stationuuid)
}
function setFavorite(ctx: Context, sessionKey: string, station: Station, saved: boolean, selectedResultId?: string): Promise<void> {
  const originalContext = sessions.get(sessionKey)?.resultContext
  // Serialize the shared settings write across both the panel and the player.
  const update = favoriteUpdates.then(async () => {
    if (isFavorite(station) === saved) return
    const next = saved ? [station, ...favorites].slice(0, 100) : favorites.filter(item => item.stationuuid !== station.stationuuid)
    await saveList(ctx, "favorites", next)
    favorites = next
    updateViews()
    const resultContext = sessions.get(sessionKey)?.resultContext
    if (resultContext) {
      await api.RefreshQuery(resultContext, {
        PreserveSelectedIndex: true,
        SelectedResultId: resultContext === originalContext ? selectedResultId : undefined
      })
    }
  })
  favoriteUpdates = update.catch(() => {})
  return update
}
async function changeStation(ctx: Context, filter: StationFilter, outside: boolean, locale: RadioLocale): Promise<void> {
  const stations = catalog.snapshot?.stations ?? [...favorites, ...recent]
  const station = chooseStation(stations, filter, player.state.station?.stationuuid || "", outside)
  if (!station) {
    await api.Notify(ctx, locale.t(outside ? "no_outside" : "no_next"))
    return
  }
  await playStation(ctx, station)
}
function sessionFor(ctx: Context, query: Query): Session {
  const key = query.SessionId || ctx.Get("SessionId") || ""
  let session = sessions.get(key)
  const selected = (value: string | undefined) => (value && value !== "all" ? value : undefined)
  const filter: StationFilter = {
    genre: selected(query.Refinements?.genre ?? query.ContextData?.radio_genre),
    country: selected(query.Refinements?.country ?? query.ContextData?.radio_country),
    language: selected(query.Refinements?.language ?? query.ContextData?.radio_language)
  }
  if (!session) {
    const view = createPlayerView(
      () => ({ state: player.state, favorite: isFavorite(player.state.station), locale: sessions.get(key)?.locale }),
      {
        toggle: async () => player.setPaused(player.state.status !== "paused"),
        next: async () => {
          const active = sessions.get(key)
          await changeStation(ctx, active?.filter || {}, false, active?.locale ?? english)
        },
        favorite: async () => {
          const station = player.state.station
          if (station) await setFavorite(ctx, key, station, !isFavorite(station))
        },
        volume: async value => player.setVolume(value)
      },
      async preview => (await api.UpdatePluginPreview(ctx, { Preview: preview })).Success,
      error => {
        void api.Log(ctx, "Error", `Radio preview: ${String(error)}`)
      },
      typeof api.UpdatePluginPreviewData === "function"
        ? async (WoxViewID, pointRadii) => (await api.UpdatePluginPreviewData!(ctx, { WoxViewID, WoxViewNodeKey: "signal", WoxViewData: { pointRadii } })).Success
        : undefined
    )
    session = { filter, view, locale: english }
    sessions.set(key, session)
  }
  session.filter = filter
  return session
}
function filterLabel(locale: RadioLocale, group: FilterGroup, value: string, fallback = value): string {
  if (group.id === "country") return locale.country(value, fallback)
  return group.id === "language" ? locale.language(value) : locale.genre(value)
}

function refinements(data: Categories, filter: StationFilter, query: Query, locale: RadioLocale): QueryRefinement[] {
  let localized = refinementOptions.get(data)
  if (!localized) {
    localized = new WeakMap()
    refinementOptions.set(data, localized)
  }
  let options = localized.get(locale)
  if (!options) {
    options = filterGroups.map(group => [
      { Value: "all", Title: locale.t("all") },
      ...data[group.field].flatMap(item => {
        const value = group.id === "country" ? item.iso_3166_1 : item.name
        if (!value || value === "all") return []
        const title = filterLabel(locale, group, value, item.name)
        const keywords = new Set([item.name, filterLabel(english, group, value, item.name), filterLabel(chinese, group, value, item.name)])
        keywords.delete(title)
        return [{ Value: value, Title: title, Keywords: [...keywords].filter(Boolean), Count: item.stationcount }]
      })
    ])
    localized.set(locale, options)
  }
  return options.map((values, index) => {
    const group = filterGroups[index]
    // Category actions seed the initial selection through ChangeQuery context.
    const initial = query.Refinements?.[group.id] ? "all" : filter[group.id] || "all"
    return { Id: group.id, Title: locale.t(group.id), Type: "singleSelect", Hotkey: `${process.platform === "darwin" ? "cmd" : "ctrl"}+${group.key}`, Options: values, DefaultValue: [initial] }
  })
}

function filterMatches(data: Categories, group: FilterGroup, term: string, limit: number, locale: RadioLocale) {
  const rank = (item: DirectoryCategory, value: string, title: string) => {
    if (!term) return 0
    const labels = [value, title, item.name, filterLabel(english, group, value, item.name), filterLabel(chinese, group, value, item.name)]
    const normalized = labels.map(label => label.toLowerCase())
    if (normalized.includes(term)) return 3
    if (normalized.some(label => label.startsWith(term))) return 2
    return normalized.some(label => label.includes(term)) ? 1 : -1
  }
  return data[group.field]
    .flatMap(item => {
      const value = group.id === "country" ? item.iso_3166_1 : item.name
      if (!value) return []
      const title = filterLabel(locale, group, value, item.name)
      const score = rank(item, value, title)
      return score < 0 ? [] : [{ value, title, count: item.stationcount, score }]
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

function changeFilter(ctx: Context, queryText: string, filter: StationFilter): Promise<void> {
  return api.ChangeQuery(ctx, {
    QueryType: "input",
    QueryText: queryText,
    ContextData: { radio_genre: filter.genre || "", radio_country: filter.country || "", radio_language: filter.language || "" }
  })
}

function filterResults(data: Categories, search: string, filter: StationFilter, stationQuery: string, locale: RadioLocale): Result[] {
  const term = search.trim().toLowerCase()
  if (term.length < 2) return []
  return filterGroups
    .flatMap(group => filterMatches(data, group, term, 3, locale).map(option => ({ group, ...option })))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(
      ({ group, value, title, count }, index): Result => ({
        Id: `category:${group.id}:${value}`,
        Title: locale.t("category_title", { type: locale.t(group.id), name: title }),
        SubTitle: [locale.t("station_count", { count }), filter[group.id] === value && locale.t("selected")].filter(Boolean).join(" · "),
        Icon: icon,
        Group: locale.t("browse_categories"),
        GroupScore: 80,
        Score: 100 - index,
        Actions: [{ Name: locale.t("apply_filter"), PreventHideAfterAction: true, Action: async ctx => changeFilter(ctx, stationQuery, { ...filter, [group.id]: value }) }]
      })
    )
}
function stationResult(station: Station, locale: RadioLocale, group = locale.t("stations"), groupScore = 10): Result {
  const id = `station:${station.stationuuid}`
  const saved = isFavorite(station)
  return {
    Id: id,
    IdentityKey: station.stationuuid,
    Title: station.name,
    SubTitle: [locale.country(station.countrycode, station.country), locale.genre(station.tags?.split(",")[0]?.trim() || ""), station.bitrate ? `${station.bitrate} kbps` : ""]
      .filter(Boolean)
      .join(" · "),
    Icon: station.favicon?.startsWith("https://") ? { ImageType: "url", ImageData: station.favicon } : icon,
    Group: group,
    GroupScore: groupScore,
    Tails: player.state.station?.stationuuid === station.stationuuid ? playingTail(locale) : [],
    Actions: [
      { Name: locale.t("play_station"), PreventHideAfterAction: true, Action: async ctx => playStation(ctx, station) },
      {
        Name: locale.t(saved ? "remove_favorite" : "add_favorite"),
        Icon: saved ? removeFavoriteIcon : addFavoriteIcon,
        PreventHideAfterAction: true,
        Action: async ctx => setFavorite(ctx, ctx.Get("SessionId") || "", station, !saved, id)
      }
    ]
  }
}

export const plugin: Plugin = {
  async init(ctx, params) {
    api = params.API as PreviewAPI
    const [cacheFolder, storedFavorites, storedRecent] = await Promise.all([api.GetCacheFolder(ctx), api.GetSetting(ctx, "favorites"), api.GetSetting(ctx, "recent")])
    favorites = parseStations(storedFavorites)
    recent = parseStations(storedRecent)
    player = new RadioPlayer(cacheFolder)
    installer = new MpvInstaller(cacheFolder)
    const executable = await installer.find()
    mpvReady = Boolean(executable)
    installMessage = { key: "install_prompt" }
    if (executable) player.setExecutable(executable)
    player.onChange = updateViews
    player.onSpectrum = () => {
      for (const session of sessions.values()) session.view.refresh()
    }
    catalog?.stop()
    catalog = new StationCatalog(
      cacheFolder,
      () => {
        if (!mpvReady) return
        for (const session of sessions.values()) {
          if (session.resultContext) void api.RefreshQuery(session.resultContext, { PreserveSelectedIndex: true }).catch(() => {})
        }
      },
      error => {
        void api.Log(ctx, "Error", `Radio directory: ${String(error)}`).catch(() => {})
      }
    )
    await catalog.start()
    await api.OnLeavePluginQuery(ctx, leaveCtx => {
      sessions.delete(leaveCtx.Get("SessionId") || "")
    })
    await api.OnUnload(ctx, async () => {
      catalog.stop()
      player.stop()
      sessions.clear()
    })
  },
  async query(ctx, query): Promise<QueryResponse> {
    const session = sessionFor(ctx, query)
    const filter = { ...session.filter }
    session.resultContext = ctx
    session.resultIDs = undefined
    const locale = radioLocale(await api.GetTranslation(ctx, "radio_locale").catch(() => ""))
    const current = session.resultContext === ctx
    if (current && session.locale !== locale) {
      session.locale = locale
      session.view.refresh()
    }
    if (!mpvReady) {
      if (current) session.resultIDs = new Set(["install-mpv"])
      return { Results: [installResult(locale)] }
    }
    const snapshot = catalog.snapshot
    const trigger = query.TriggerKeyword || "radio"
    const respond = (results: Result[]): QueryResponse => {
      if (current) {
        session.resultIDs = new Set(results.map(result => result.Id || ""))
        session.marked = player.state.station ? `station:${player.state.station.stationuuid}` : ""
      }
      return {
        Results: results,
        Refinements: snapshot ? refinements(snapshot.categories, filter, query, locale) : [],
        Layout: { ResultPreviewWidthRatio: 0.42 },
        PluginPreview: session.view.initialPreview
      } as QueryResponse
    }
    const selections = filterGroups.flatMap(group => {
      const value = filter[group.id]
      return value ? [filterLabel(locale, group, value)] : []
    })
    const filtered = selections.length > 0
    const scope = selections.join(" · ") || locale.t("all_stations")
    const quick: Result[] = [
      {
        Id: "next",
        Title: locale.t("next_station"),
        SubTitle: locale.t("next_in_scope", { scope }),
        Icon: nextIcon,
        Group: locale.t("quick_listen"),
        GroupScore: 100,
        Score: 100,
        Actions: [{ Name: locale.t("play_next"), PreventHideAfterAction: true, Action: async actionCtx => changeStation(actionCtx, filter, false, locale) }]
      },
      {
        Id: "explore",
        Title: locale.t(filtered ? "explore_elsewhere" : "random_station"),
        SubTitle: locale.t(filtered ? "random_outside" : "random_all", { scope }),
        Icon: randomIcon,
        Group: locale.t("quick_listen"),
        GroupScore: 100,
        Score: 90,
        Actions: [{ Name: locale.t("play_random"), PreventHideAfterAction: true, Action: async actionCtx => changeStation(actionCtx, filter, true, locale) }]
      }
    ]
    const entries = snapshot ? filterResults(snapshot.categories, query.Search, filter, `${trigger} `, locale) : []
    const seen = new Set<string>()
    const term = query.Search.trim().toLowerCase()
    for (const saved of favorites) {
      const station = snapshot?.station(saved.stationuuid) ?? saved
      if (!matchesSavedStation(station, filter, term)) continue
      entries.push(stationResult(station, locale, locale.t("favorites"), 40))
      seen.add(station.stationuuid)
    }
    if ((!query.Search && !filtered) || !snapshot) {
      for (const station of recent)
        if (!seen.has(station.stationuuid) && matchesFilter(station, filter) && station.name.toLowerCase().includes(term)) {
          entries.push(stationResult(station, locale, locale.t("recently_played"), 30))
          seen.add(station.stationuuid)
        }
    }
    if (snapshot) {
      entries.push(
        ...snapshot
          .search(query.Search, filter)
          .filter(station => !seen.has(station.stationuuid))
          .map(station => stationResult(station, locale))
      )
    } else {
      entries.push({
        Id: "directory-status",
        Title: locale.t(catalog.unavailable ? "directory_unavailable" : "directory_loading"),
        SubTitle: locale.t(catalog.unavailable ? "directory_retry" : "directory_auto_show"),
        Icon: icon
      })
    }
    return respond([...quick, ...entries])
  }
}
