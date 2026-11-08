import { randomUUID } from "node:crypto"
import { Context } from "@wox-launcher/wox-plugin"
import { english, RadioLocale } from "./i18n"
import { PlaybackState } from "./player"

export interface PlayerViewActions {
  toggle(): Promise<void>
  next(): Promise<void>
  favorite(): Promise<void>
  volume(value: number): Promise<void>
}

export interface PlayerViewPreview {
  PreviewType: "woxview"
  PreviewData: string
  WoxViewID: string
  OnWoxViewEvent(ctx: Context, event: { Type?: string; Handler?: string; Args?: unknown[] }): Promise<void>
}

type Style = Record<string, unknown>
const text = (value: string, style: Style) => ({ type: "text", props: { text: value, style } })
const sweepDuration = 720
const signalHeight = 162
const baseline = 96
const highlightColor = { light: "$accent", dark: "$focus" }
const strokes = Array.from({ length: 47 }, (_, i) => {
  const x = i / 46
  const crest = 82 * Math.exp(-Math.pow((x - 0.72) / 0.17, 2))
  const trough = 52 * Math.exp(-Math.pow((x - 0.26) / 0.15, 2))
  const displacement = crest - trough
  return { top: displacement > 0 ? baseline - displacement : baseline, height: Math.max(2, Math.abs(displacement)) }
})

function spectrumBars(levels: readonly number[]) {
  const columns = 41
  return Array.from({ length: columns }, (_, index) => {
    const band = (index / (columns - 1)) * (levels.length - 1)
    const low = Math.floor(band)
    const fraction = band - low
    const blend = fraction * fraction * (3 - 2 * fraction)
    const level = levels[low] + (levels[Math.ceil(band)] - levels[low]) * blend
    const height = 2.5 + level * 88
    const stroke = (key: string, anchor: Style, height: number, opacity: number) => ({
      type: "view",
      key,
      props: {
        style: { ...anchor, width: 2.6, height, borderRadius: 1.3, backgroundColor: highlightColor, opacity },
        transition: { properties: ["height", "opacity"], duration: 135 }
      }
    })
    return {
      type: "stack",
      key: `band-${index}`,
      props: { style: { width: 2.6, height: signalHeight } },
      children: [stroke("upper", { bottom: signalHeight - baseline }, height, 0.44 + level * 0.54), stroke("reflection", { top: baseline + 3 }, Math.max(1, height * 0.32), 0.1 + level * 0.22)]
    }
  })
}

function signalBand(state: PlaybackState, locale: RadioLocale) {
  const elapsed = state.tune ? Math.max(0, Date.now() - state.tune.startedAt) : sweepDuration
  const sweep = state.tune && elapsed < sweepDuration ? { playbackId: String(state.tune.id), elapsed, duration: sweepDuration } : undefined
  const spectrum = state.status === "playing" && !sweep && state.spectrum?.length ? state.spectrum : undefined
  return {
    type: "column",
    key: "signal",
    props: { style: { flex: 1, alignItems: "stretch", justifyContent: "center", overflow: "hidden" } },
    children: [
      {
        type: "stack",
        props: { style: { height: signalHeight } },
        children: [
          { type: "view", props: { style: { left: 0, right: 0, top: baseline, height: 1, backgroundColor: "$border" } } },
          {
            type: "row",
            props: { style: { left: 0, right: 0, top: 0, height: signalHeight, justifyContent: "space-between" } },
            children: spectrum
              ? spectrumBars(spectrum)
              : strokes.map(({ top, height }, index) => {
                  const start = 24 + index * 10
                  const opacity = state.station ? 0.74 : 0.44
                  const bar = { top, width: 1.4, height, borderRadius: 1 }
                  return {
                    type: "stack",
                    key: `stroke-${index}`,
                    props: { style: { width: 1.4, height: signalHeight } },
                    children: [
                      { type: "view", props: { style: { ...bar, backgroundColor: highlightColor, opacity } } },
                      ...(sweep
                        ? [
                            {
                              type: "view",
                              key: "scan",
                              props: {
                                style: { ...bar, backgroundColor: "$text", opacity: 0 },
                                // Staggered native keyframes scale the scan to the available width.
                                timeline: {
                                  ...sweep,
                                  keyframes: [
                                    { at: 0, opacity: 0 },
                                    { at: start, opacity: 0 },
                                    { at: start + 54, opacity: 0.92 },
                                    { at: start + 150, opacity: 0 },
                                    { at: sweepDuration, opacity: 0 }
                                  ]
                                }
                              }
                            }
                          ]
                        : [])
                    ]
                  }
                })
          },
          ...(spectrum
            ? [
                {
                  type: "row",
                  key: "frequency-labels",
                  props: { style: { left: 0, right: 0, bottom: 14, justifyContent: "space-between" } },
                  children: (["low", "mid", "high"] as const).map(key => text(locale.t(key), { color: "$textSecondary", fontFamily: "monospace", fontSize: 9, opacity: 0.72 }))
                }
              ]
            : [])
        ]
      }
    ]
  }
}

function stationDetails(state: PlaybackState, locale: RadioLocale): string {
  if (state.status === "connecting") return locale.t("connecting_stream")
  if (state.error) return locale.t(state.error.key, state.error.values)
  const station = state.station
  if (!station) return locale.t("choose_station")
  const country = locale.country(station.countrycode, station.country)
  const genre = station.tags
    ?.split(",")
    .map(tag => tag.trim())
    .find(tag => tag && !/^\d+$/.test(tag) && tag.toLowerCase() !== country?.toLowerCase())
  return [country, genre && locale.genre(genre), station.bitrate ? `${station.bitrate} kbps` : ""].filter(Boolean).join(" · ")
}

function transportButton(key: string, label: string, icon: string, active: boolean, disabled = false) {
  const size = key === "toggle" ? 42 : 32
  return {
    type: "icon-button",
    key,
    props: {
      label,
      icon,
      iconColorMode: "tint",
      disabled,
      onPress: { $handler: key },
      style: {
        width: size,
        height: size,
        borderRadius: size / 2,
        color: key === "toggle" ? "$accentText" : active ? highlightColor : "$text",
        ...(key === "toggle" && { backgroundColor: "$accent" })
      },
      hoverStyle: { backgroundColor: key === "toggle" ? "$accent" : "$hover" },
      pressedStyle: { backgroundColor: "$selected", color: "$selectedText" },
      disabledStyle: { color: "$disabled", backgroundColor: "$hover" }
    }
  }
}

export function playerTree(state: PlaybackState, favorite: boolean, locale = english): string {
  const playing = state.status === "playing"
  const paused = state.status === "paused"
  const tuning = state.status === "connecting"
  const status = { stopped: "player_ready", connecting: "player_tuning", playing: "player_on_air", paused: "player_paused", error: "player_unavailable" } as const
  const statusColor = state.status === "error" ? "$error" : playing || tuning ? highlightColor : "$textSecondary"
  const name = state.station?.name || locale.t("radio_name")
  return JSON.stringify({
    version: 1,
    root: {
      type: "column",
      props: { style: { padding: { horizontal: 18, vertical: 16 }, gap: 14, alignItems: "stretch", backgroundColor: "$surface", borderRadius: "$radiusMd" } },
      children: [
        {
          type: "column",
          key: `station:${state.station?.stationuuid ?? "idle"}`,
          props: { enter: { type: "slideUp", duration: 220 }, style: { gap: 6, alignItems: "stretch", padding: { top: 8 } } },
          children: [
            text(name, { fontSize: name.length > 27 ? 27 : 32, fontWeight: "semibold", color: "$text", maxLines: 2 }),
            {
              type: "row",
              key: "station-details",
              props: { style: { gap: 8, alignItems: "center" } },
              children: [
                text(stationDetails(state, locale), { flex: 1, color: state.error ? "$error" : "$textSecondary", fontSize: "$fontMd", maxLines: 2 }),
                {
                  type: "view",
                  key: "pilot",
                  props: {
                    style: { width: 6, height: 6, borderRadius: 3, backgroundColor: statusColor },
                    ...(tuning ? { animation: { type: "pulse", duration: 900 } } : {})
                  }
                },
                text(locale.t(status[state.status]), { color: "$textSecondary", fontFamily: "monospace", fontSize: 10, fontWeight: "semibold", maxLines: 1 })
              ]
            }
          ]
        },
        signalBand(state, locale),
        { type: "view", props: { style: { height: 1, backgroundColor: "$border" } } },
        {
          type: "row",
          key: "controls",
          props: { style: { gap: 8, alignItems: "center" } },
          children: [
            transportButton("toggle", locale.t(playing ? "pause" : paused ? "resume" : "play"), playing ? "action.pause" : "control.play-arrow", true, !playing && !paused),
            transportButton("next", locale.t("next_station"), "action.skip-next", false),
            transportButton("favorite", locale.t(favorite ? "remove_favorite" : "add_favorite"), favorite ? "control.star-filled" : "action.star", favorite, !state.station),
            { type: "view", props: { style: { width: 1, height: 24, backgroundColor: "$border" } } },
            { type: "image", props: { icon: "action.volume", iconColorMode: "tint", style: { width: 15, height: 15, color: "$textSecondary" } } },
            {
              type: "slider",
              key: "volume",
              props: {
                name: "volume",
                label: locale.t("volume"),
                min: 0,
                max: 100,
                step: 1,
                value: state.volume,
                onChange: { $handler: "volume" },
                style: { flex: 1 }
              }
            },
            text(locale.percent(state.volume), { color: "$textSecondary", fontFamily: "monospace", fontSize: 11, fontWeight: "semibold", maxLines: 1 })
          ]
        }
      ]
    }
  })
}

// Each preview owns one stable document ID; state changes are explicit updates.
export function createPlayerView(
  read: () => { state: PlaybackState; favorite: boolean; locale?: RadioLocale },
  actions: PlayerViewActions,
  update: (preview: PlayerViewPreview) => Promise<boolean>,
  onError: (error: unknown) => void
) {
  let running = false
  let dirty = false
  let visible = false
  const preview: PlayerViewPreview = {
    PreviewType: "woxview",
    get PreviewData() {
      const { state, favorite, locale } = read()
      return playerTree(state, favorite, locale)
    },
    WoxViewID: randomUUID(),
    async OnWoxViewEvent(_ctx, event) {
      if (event.Type === "show") {
        visible = true
        refresh()
        return
      }
      if (event.Type === "hide") {
        visible = false
        return
      }
      try {
        if (event.Handler === "toggle") await actions.toggle()
        else if (event.Handler === "next") await actions.next()
        else if (event.Handler === "favorite") await actions.favorite()
        else if (event.Handler === "volume" && typeof event.Args?.[0] === "number") await actions.volume(event.Args[0])
      } catch (error) {
        onError(error)
      }
    }
  }
  function refresh(): void {
    dirty = true
    if (!visible || running) return
    running = true
    void (async () => {
      try {
        while (visible && dirty) {
          dirty = false
          if (!(await update({ ...preview }))) break
        }
      } catch (error) {
        onError(error)
      } finally {
        running = false
      }
    })()
  }
  return { preview, refresh }
}
