export interface Station {
  stationuuid: string
  name: string
  url_resolved: string
  countrycode: string
  country: string
  language: string
  tags: string
  bitrate: number
  favicon: string
}

export interface StationFilter {
  genre?: string
  country?: string
  language?: string
}

export interface DirectoryCategory {
  name: string
  stationcount: number
  iso_3166_1?: string
}

export type Categories = Record<"tags" | "countries" | "languages", DirectoryCategory[]>

const endpoint = "https://de1.api.radio-browser.info/json/stations/search"
const refreshInterval = 24 * 60 * 60 * 1000
const retryInterval = 5 * 60 * 1000
const labels = (value: string | undefined) =>
  (value || "")
    .split(",")
    .map(item => item.trim().toLowerCase())
    .filter(Boolean)

// Radio Browser stores genres and languages as comma-separated tags.
export function matchesFilter(station: Station, filter: StationFilter): boolean {
  const has = (values: string | undefined, value: string) => (values || "").split(",").some(item => item.trim().toLowerCase() === value.toLowerCase())
  return (
    (!filter.genre || has(station.tags, filter.genre)) &&
    (!filter.country || (station.countrycode || "").toLowerCase() === filter.country.toLowerCase()) &&
    (!filter.language || has(station.language, filter.language))
  )
}

function matchesSearch(name: string, tags: string[], term: string): boolean {
  return name.includes(term) || tags.some(tag => tag.includes(term))
}

// Saved stations use the same name and tag search as the indexed directory.
export function matchesSavedStation(station: Station, filter: StationFilter, term: string): boolean {
  return matchesFilter(station, filter) && (!term || matchesSearch(station.name.toLowerCase(), labels(station.tags), term))
}

// Choose outside the complete intersection, not outside every individual filter.
export function chooseStation(stations: Station[], filter: StationFilter, currentID: string, outside: boolean, random = Math.random): Station | undefined {
  const hasFilter = Boolean(filter.genre || filter.country || filter.language)
  const candidates = stations.filter(station => station.stationuuid !== currentID && (outside && hasFilter ? !matchesFilter(station, filter) : matchesFilter(station, filter)))
  return candidates[Math.floor(random() * candidates.length)]
}

export async function searchStations(search: string, filter: StationFilter, limit = 100, signal = AbortSignal.timeout(10000)): Promise<Station[]> {
  const url = new URL(endpoint)
  const parameters: Record<string, string> = {
    hidebroken: "true",
    limit: String(limit),
    order: "clickcount",
    reverse: "true"
  }
  if (search.trim()) parameters.name = search.trim()
  if (filter.genre) {
    parameters.tag = filter.genre
    parameters.tagExact = "true"
  }
  if (filter.country) parameters.countrycode = filter.country
  if (filter.language) {
    parameters.language = filter.language
    parameters.languageExact = "true"
  }
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value)
  const response = await fetch(url, { headers: { "User-Agent": "Wox.Plugin.Radio/0.0.8" }, signal })
  if (!response.ok) throw new Error(`Radio Browser returned ${response.status}`)
  return parseStations(await response.json())
}
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

function parseStations(data: unknown): Station[] {
  if (!Array.isArray(data)) throw new Error("Invalid station list")
  const stations = new Map<string, Station>()
  const string = (value: unknown) => (typeof value === "string" ? value : "")
  for (const station of data) {
    if (!station || !string(station.stationuuid) || !string(station.name).trim() || !/^https?:\/\//i.test(string(station.url_resolved))) continue
    if (stations.has(station.stationuuid)) continue
    stations.set(station.stationuuid, {
      stationuuid: station.stationuuid,
      name: station.name.trim(),
      url_resolved: station.url_resolved,
      countrycode: string(station.countrycode).toUpperCase(),
      country: string(station.country),
      language: string(station.language),
      tags: string(station.tags),
      bitrate: typeof station.bitrate === "number" && Number.isFinite(station.bitrate) ? station.bitrate : 0,
      favicon: string(station.favicon)
    })
  }
  return [...stations.values()]
}

export class DirectorySnapshot {
  readonly categories: Categories
  private readonly entries = new Map<string, { station: Station; name: string; tags: string[]; languages: string[] }>()

  constructor(readonly stations: Station[]) {
    const tags = new Map<string, DirectoryCategory>()
    const countries = new Map<string, DirectoryCategory>()
    const languages = new Map<string, DirectoryCategory>()
    const count = (group: Map<string, DirectoryCategory>, key: string, name: string, iso?: string) => {
      const category = group.get(key)
      if (category) category.stationcount++
      else group.set(key, { name, stationcount: 1, ...(iso && { iso_3166_1: iso }) })
    }
    for (const station of stations) {
      const stationTags = labels(station.tags)
      const stationLanguages = labels(station.language)
      for (const tag of new Set(stationTags)) count(tags, tag, tag)
      for (const language of new Set(stationLanguages)) count(languages, language, language)
      if (station.countrycode) count(countries, station.countrycode, station.country || station.countrycode, station.countrycode)
      this.entries.set(station.stationuuid, { station, name: station.name.toLowerCase(), tags: stationTags, languages: stationLanguages })
    }
    const sorted = (group: Map<string, DirectoryCategory>) => [...group.values()].sort((a, b) => b.stationcount - a.stationcount)
    this.categories = { tags: sorted(tags), countries: sorted(countries), languages: sorted(languages) }
  }

  station(id: string): Station | undefined {
    return this.entries.get(id)?.station
  }

  search(search: string, filter: StationFilter, limit = 100): Station[] {
    const term = search.trim().toLowerCase()
    const genre = filter.genre?.toLowerCase()
    const country = filter.country?.toUpperCase()
    const language = filter.language?.toLowerCase()
    const result: Station[] = []
    for (const entry of this.entries.values()) {
      if ((country && country !== entry.station.countrycode) || (genre && !entry.tags.includes(genre)) || (language && !entry.languages.includes(language))) continue
      if (term && !matchesSearch(entry.name, entry.tags, term)) continue
      result.push(entry.station)
      if (result.length >= limit) break
    }
    return result
  }
}

export class StationCatalog {
  snapshot?: DirectorySnapshot
  unavailable = false
  private readonly abort = new AbortController()
  private timer?: NodeJS.Timeout

  constructor(
    private readonly folder: string,
    private readonly onChange: () => void,
    private readonly onError: (error: unknown) => void
  ) {}

  async start(): Promise<void> {
    let nextRefresh = 0
    if (this.folder) {
      try {
        const cached = JSON.parse(await readFile(join(this.folder, "stations-v1.json"), "utf8"))
        const stations = parseStations(cached.stations)
        if (stations.length) {
          this.snapshot = new DirectorySnapshot(stations)
          if (Number.isFinite(cached.updatedAt)) nextRefresh = Math.min(refreshInterval, Math.max(0, cached.updatedAt + refreshInterval - Date.now()))
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.onError(error)
      }
    }
    this.schedule(nextRefresh)
  }

  stop(): void {
    this.abort.abort()
    clearTimeout(this.timer)
  }

  private schedule(delay: number): void {
    if (this.abort.signal.aborted) return
    this.timer = setTimeout(() => {
      void this.refresh()
    }, delay)
    this.timer.unref()
  }

  private async refresh(): Promise<void> {
    let delay = retryInterval
    try {
      if (!this.snapshot) {
        // Show a small list first while the full directory downloads in the background.
        const initial = await this.download(500, 15000)
        this.publish(initial)
        if (this.folder) await this.save(initial, 0).catch(this.onError)
      }
      const stations = await this.download(100000, 180000)
      if (this.abort.signal.aborted) return
      this.publish(stations)
      delay = refreshInterval
      if (this.folder) await this.save(stations)
    } catch (error) {
      if (this.abort.signal.aborted) return
      this.onError(error)
      if (!this.snapshot && !this.unavailable) {
        this.unavailable = true
        this.onChange()
      }
    } finally {
      this.schedule(delay)
    }
  }

  private async download(limit: number, timeout: number): Promise<Station[]> {
    const stations = await searchStations("", {}, limit, AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeout)]))
    if (!stations.length) throw new Error("Radio Browser returned an empty directory")
    return stations
  }

  private publish(stations: Station[]): void {
    if (this.abort.signal.aborted) return
    this.snapshot = new DirectorySnapshot(stations)
    this.unavailable = false
    this.onChange()
  }

  private async save(stations: Station[], updatedAt = Date.now()): Promise<void> {
    await mkdir(this.folder, { recursive: true })
    const staging = join(this.folder, `stations-${randomUUID()}.tmp`)
    try {
      await writeFile(staging, JSON.stringify({ updatedAt, stations }))
      await rename(staging, join(this.folder, "stations-v1.json"))
    } finally {
      await rm(staging, { force: true })
    }
  }
}
