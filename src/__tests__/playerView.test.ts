import { Context } from "@wox-launcher/wox-plugin"
import { createPlayerView, playerTree } from "../playerView"
import { PlaybackState } from "../player"

test("the player view uses Wox theme tokens and reflects playback state", () => {
  const idle = playerTree({ status: "stopped", volume: 30 }, false)
  expect(idle).toContain("READY")
  expect(idle).toContain('"key":"signal"')
  expect(idle).not.toContain('"timeline"')

  const state: PlaybackState = { status: "connecting", volume: 30, tune: { startedAt: Date.now() - 8000 } }
  const tuning = playerTree(state, false)
  expect(tuning).toContain("$accent")
  expect(tuning).toContain("TUNING")
  expect(tuning).toContain('"type":"pulse"')
  const playing = playerTree({ ...state, status: "playing", spectrum: [0.8, 0.2] }, false)
  expect(playing).toContain("ON AIR")
  expect(Buffer.byteLength(playing)).toBeLessThan(30_000)
  expect(playing).not.toMatch(/"text":"(?:LOW|MID|HIGH)"/)
  expect(playing).not.toContain('"type":"pulse"')
  expect(playing).not.toContain('"timeline"')
})

test("the visible preview grows from a flat wave and keeps tuning until spectrum arrives", async () => {
  jest.useFakeTimers({ now: 1000 })
  try {
    const idle: PlaybackState = { status: "stopped", volume: 30 }
    const tune = { startedAt: Date.now() }
    let state: PlaybackState = { ...idle, status: "connecting", tune }
    const update = jest.fn(async () => true)
    const view = createPlayerView(
      () => ({ state, favorite: false }),
      { toggle: async () => {}, next: async () => {}, favorite: async () => {}, volume: async () => {} },
      update,
      error => {
        throw error
      }
    )
    const wave = (data: string) => {
      const { children: rows } = JSON.parse(data).root.children[1] as { children: { children: { props: { source: { imageData: string } } }[] }[] }
      return rows.flatMap(row => row.children.map(image => image.props.source.imageData))
    }
    const flat = wave(playerTree(idle, false))
    expect(flat.length).toBeGreaterThan(0)
    expect(flat.every(row => row.match(/M/g)?.length === 49)).toBe(true)
    const ctx = {} as Context
    await view.preview.OnWoxViewEvent(ctx, { Type: "show" })
    expect(wave(view.preview.PreviewData)).toEqual(flat)
    await jest.advanceTimersByTimeAsync(400)
    const lastWave = wave(view.preview.PreviewData)
    expect(lastWave).not.toEqual(flat)

    const connected = { ...tune, connectedAt: Date.now() }
    state = { ...state, status: "playing", tune: connected }
    expect(wave(view.preview.PreviewData)).toEqual(lastWave)
    view.refresh()
    const waiting = update.mock.calls.length
    await jest.advanceTimersByTimeAsync(80)
    expect(update.mock.calls.length).toBeGreaterThan(waiting)

    const beforeHandoff = wave(view.preview.PreviewData)
    state = { ...state, tune: { ...connected, spectrumAt: Date.now() }, spectrum: [0.8, 0.2] }
    const target = wave(playerTree(state, false))
    view.refresh()
    expect(wave(view.preview.PreviewData)).toEqual(beforeHandoff)
    await jest.advanceTimersByTimeAsync(120)
    const duringHandoff = wave(view.preview.PreviewData)
    expect(duringHandoff).not.toEqual(beforeHandoff)
    expect(duringHandoff).not.toEqual(target)
    await jest.advanceTimersByTimeAsync(120)
    expect(wave(view.preview.PreviewData)).toEqual(target)
    const playing = update.mock.calls.length
    await jest.advanceTimersByTimeAsync(400)
    expect(update).toHaveBeenCalledTimes(playing)

    state = { ...idle, status: "connecting", tune: { startedAt: Date.now() } }
    view.refresh()
    await jest.advanceTimersByTimeAsync(0)
    await view.preview.OnWoxViewEvent(ctx, { Type: "hide" })
    const hidden = update.mock.calls.length
    await jest.advanceTimersByTimeAsync(400)
    expect(update).toHaveBeenCalledTimes(hidden)
  } finally {
    jest.useRealTimers()
  }
})

test("preview dispatches controls and pushes fresh state without changing document", async () => {
  let state: PlaybackState = { status: "playing", volume: 30 }
  const updates: string[] = []
  const actions = {
    toggle: jest.fn(async () => {
      state = { ...state, status: "paused" }
    }),
    next: jest.fn(async () => {}),
    favorite: jest.fn(async () => {}),
    volume: jest.fn(async () => {})
  }
  const view = createPlayerView(
    () => ({ state, favorite: false }),
    actions,
    async preview => {
      updates.push(preview.PreviewData)
      return true
    },
    error => {
      throw error
    }
  )
  const ctx = {} as Context
  await view.preview.OnWoxViewEvent(ctx, { Type: "show" })
  await view.preview.OnWoxViewEvent(ctx, { Handler: "toggle", Args: [] })
  view.refresh()
  await new Promise(resolve => setImmediate(resolve))
  expect(actions.toggle).toHaveBeenCalledTimes(1)
  expect(updates[updates.length - 1]).toContain("PAUSED")
  const document = view.preview.WoxViewID
  await view.preview.OnWoxViewEvent(ctx, { Handler: "volume", Args: [55] })
  expect(actions.volume).toHaveBeenCalledWith(55)
  expect(view.preview.WoxViewID).toBe(document)
  await view.preview.OnWoxViewEvent(ctx, { Type: "hide" })
  const before = updates.length
  view.refresh()
  await new Promise(resolve => setImmediate(resolve))
  expect(updates.length).toBe(before)
})

test("supported hosts receive radius snapshots while typing and full documents for control changes", async () => {
  jest.useFakeTimers({ now: 1000 })
  try {
    let state: PlaybackState = { status: "playing", volume: 30, spectrum: [0.2, 0.4] }
    const full: string[] = []
    const patches: number[][] = []
    const view = createPlayerView(
      () => ({ state, favorite: false }),
      { toggle: async () => {}, next: async () => {}, favorite: async () => {}, volume: async () => {} },
      async preview => {
        full.push(preview.PreviewData)
        return true
      },
      error => {
        throw error
      },
      async (_id, radii) => {
        patches.push(radii)
        return true
      }
    )
    expect(view.initialPreview?.PreviewData).toContain('"type":"scatter-chart"')
    const ctx = {} as Context
    await view.preview.OnWoxViewEvent(ctx, { Type: "show" })
    expect(view.initialPreview).toBeUndefined()
    const initial = JSON.parse(full[0]).root.children[1].props.pointRadii
    state = { ...state, spectrum: [0.8, 0.6] }
    view.refresh()
    await jest.advanceTimersByTimeAsync(80)
    expect(full).toHaveLength(1)
    expect(patches).toHaveLength(2)
    expect(patches[0]).toHaveLength(initial.length)
    expect(patches[0]).not.toEqual(initial)
    expect(patches[0]).not.toEqual(patches[1])
    expect(Buffer.byteLength(JSON.stringify(patches[1]))).toBeLessThan(7000)

    state = { ...state, volume: 42 }
    view.refresh()
    await jest.advanceTimersByTimeAsync(0)
    expect(full).toHaveLength(2)
    expect(full[1]).toContain("42%")
    expect(JSON.parse(full[1]).root.children[1].props.pointRadii).toEqual(patches[1])
    await view.preview.OnWoxViewEvent(ctx, { Type: "hide" })
    expect(view.initialPreview).toBeDefined()
  } finally {
    jest.useRealTimers()
  }
})
