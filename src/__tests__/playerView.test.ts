import { Context } from "@wox-launcher/wox-plugin"
import { createPlayerView, playerTree } from "../playerView"
import { PlaybackState } from "../player"

test("the player view uses Wox theme tokens and reflects playback state", () => {
  const state: PlaybackState = { status: "connecting", volume: 30, tune: { id: 7, startedAt: Date.now() } }
  const tuning = playerTree(state, false)
  expect(tuning).toContain("$accent")
  expect(tuning).toContain("TUNING")
  expect(tuning).toContain('"type":"pulse"')
  const playing = playerTree({ ...state, status: "playing" }, false)
  expect(playing).toContain("ON AIR")
  expect(playing).toContain('"playbackId":"7"')
  expect(playing).not.toContain('"type":"pulse"')
  expect(playerTree({ ...state, status: "playing", tune: { id: 7, startedAt: Date.now() - 1000 } }, false)).not.toContain('"timeline"')
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
