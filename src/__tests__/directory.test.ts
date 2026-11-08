import { chooseStation, DirectorySnapshot, matchesFilter, searchStations, Station } from "../directory"

const station: Station = {
  stationuuid: "one",
  name: "Jazz",
  url_resolved: "https://example.com/stream",
  countrycode: "JP",
  country: "Japan",
  language: "japanese,english",
  tags: "jazz, soul",
  bitrate: 128,
  favicon: ""
}

test("the listening scope is the intersection of selected filters", () => {
  expect(matchesFilter(station, { genre: "Jazz", country: "jp", language: "english" })).toBe(true)
  expect(matchesFilter(station, { genre: "jazz", country: "US" })).toBe(false)
  expect(matchesFilter(station, {})).toBe(true)
})

test("next stays in the scope and explore leaves its intersection", () => {
  const japaneseJazz = { ...station, stationuuid: "two" }
  const frenchJazz = { ...station, stationuuid: "three", countrycode: "FR" }
  const japaneseNews = { ...station, stationuuid: "four", tags: "news" }
  const all = [station, japaneseJazz, frenchJazz, japaneseNews]
  const filter = { genre: "jazz", country: "JP" }
  expect(chooseStation(all, filter, "one", false, () => 0)).toEqual(japaneseJazz)
  expect(chooseStation(all, filter, "one", true, () => 0)).toEqual(frenchJazz)
  expect(chooseStation([station], filter, "one", false)).toBeUndefined()
  expect(chooseStation(all, {}, "one", true, () => 0)).toEqual(japaneseJazz)
})

test("station searches encode filters and reject invalid stream URLs", async () => {
  const original = global.fetch
  const mock = jest.fn().mockResolvedValue({ ok: true, json: async () => [station, { ...station, url_resolved: "file:///tmp/a" }] })
  global.fetch = mock
  try {
    expect(await searchStations("Tokyo Jazz", { genre: "jazz", country: "JP" })).toEqual([station])
    const url = new URL(mock.mock.calls[0][0] as URL)
    expect(url.searchParams.get("name")).toBe("Tokyo Jazz")
    expect(url.searchParams.get("tagExact")).toBe("true")
    expect(url.searchParams.get("countrycode")).toBe("JP")
  } finally {
    global.fetch = original
  }
})

test("the local snapshot searches station names and tags inside the selected scope", () => {
  const snapshot = new DirectorySnapshot([
    { ...station, name: "Tokyo One", tags: "acid jazz, jazz, jazz" },
    { ...station, stationuuid: "two", countrycode: "FR", country: "France" }
  ])
  expect(snapshot.search("acid jazz", { country: "jp", language: "japanese" }).map(item => item.stationuuid)).toEqual(["one"])
  expect(snapshot.search("acid jazz", { country: "FR" })).toEqual([])
  expect(snapshot.categories.tags.find(tag => tag.name === "jazz")?.stationcount).toBe(2)
})
