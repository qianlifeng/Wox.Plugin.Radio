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
const dotSize = 2.4
const waveDuration = 80
const handoffDuration = 240
const frameInterval = 40
const highlightColor = { light: "$accent", dark: "$focus" }
const tuningDuration = 2400
const tuningRise = 400
const spectrumGrace = 1000
const idleLevel = 0.15
const waveColumnCount = 49
const waveRowCount = 32
const rowWidth = (waveColumnCount - 1) * 8 + dotSize
const dotPaths = Array.from({ length: waveColumnCount }, (_, column) => `M${column * 8 + dotSize / 2} ${dotSize / 2}h.05`)
const rowOpacity = Array.from({ length: waveRowCount }, (_, row) => (0.015 + (0.485 * (waveRowCount - 1 - row)) / (waveRowCount - 1)).toFixed(3))
const chartPoints = Array.from({ length: waveColumnCount * waveRowCount }, (_, index) => ({
  x: index % waveColumnCount,
  y: waveRowCount - 0.5 - Math.floor(index / waveColumnCount)
}))
// Invisible endpoints keep the domain fixed even when no dots are visible.
chartPoints.push({ x: 0, y: 0 }, { x: waveColumnCount - 1, y: waveRowCount })
const chartColors = rowOpacity.flatMap(opacity => {
  const alpha = Math.round(255 * Number(opacity))
    .toString(16)
    .padStart(2, "0")
  return Array.from({ length: waveColumnCount }, () => ({ light: `#000000${alpha}`, dark: `#ffffff${alpha}` }))
})

function dotDiameter(level: number, fromBottom: number): number {
  const coverage = Math.max(0, Math.min(1, level * waveRowCount - fromBottom))
  return Math.round(10 * dotSize * Math.sqrt(coverage)) / 10
}

function signalRadii(levels: readonly number[]): number[] {
  const radii = rowOpacity.flatMap((_, row) => levels.map(level => dotDiameter(level, waveRowCount - 1 - row) / 2))
  radii.push(0, 0)
  return radii
}

function signalChart(pointRadii: number[]) {
  return {
    type: "scatter-chart",
    key: "signal",
    props: {
      style: { flex: 1 },
      chart: { hover: false, pointRadius: dotSize / 2, plotPadding: 0, colors: [...chartColors, "#00000000", "#00000000"] },
      points: chartPoints,
      pointRadii
    }
  }
}

function playingSpectrum(state: PlaybackState): readonly number[] | undefined {
  return state.status === "playing" && state.spectrum?.length ? state.spectrum : undefined
}

function tuningAge({ status, tune, spectrum }: PlaybackState, now: number): number | undefined {
  if (!tune) return undefined
  const waitingForSpectrum = status === "playing" && !spectrum?.length && tune.connectedAt !== undefined && now - tune.connectedAt < spectrumGrace
  return status === "connecting" || waitingForSpectrum ? Math.max(0, now - tune.startedAt) : undefined
}

function waveLevels(spectrum: readonly number[] | undefined, age = 0): number[] {
  const progress = Math.min(1, age / tuningRise)
  const ramp = progress * progress * (3 - 2 * progress)
  return Array.from({ length: waveColumnCount }, (_, index) => {
    const position = index / (waveColumnCount - 1)
    let level = idleLevel
    if (spectrum) {
      const band = position * (spectrum.length - 1)
      const low = Math.floor(band)
      const fraction = band - low
      const blend = fraction * fraction * (3 - 2 * fraction)
      level = spectrum[low] + (spectrum[Math.ceil(band)] - spectrum[low]) * blend
    } else if (ramp > 0) {
      const phase = position * 1.5 - 0.25 - (age % tuningDuration) / tuningDuration
      const wave = 0.44 + 0.19 * Math.cos(2 * Math.PI * phase)
      level += (wave - idleLevel) * ramp
    }
    return level
  })
}

function signalBand(levels: readonly number[]) {
  return {
    type: "column",
    key: "signal",
    props: { style: { flex: 1, alignItems: "stretch", overflow: "hidden" } },
    // One image per row keeps the adaptive grid without laying out a widget for each dot.
    children: Array.from({ length: waveRowCount }, (_, row) => {
      const fromBottom = waveRowCount - 1 - row
      const paths = new Map<number, string>()
      levels.forEach((level, column) => {
        const diameter = dotDiameter(level, fromBottom)
        if (diameter > 0) paths.set(diameter, (paths.get(diameter) ?? "") + dotPaths[column])
      })
      const strokes = Array.from(paths, ([diameter, path]) => `<path stroke-width="${diameter}" d="${path}"/>`).join("")
      return {
        type: "column",
        props: { style: { flex: 1, alignItems: "stretch", justifyContent: "center" } },
        children: strokes
          ? [
              {
                type: "image",
                props: {
                  source: {
                    imageType: "svg",
                    imageData: `<svg viewBox="0 0 ${rowWidth} ${dotSize}"><g fill="none" stroke="var(--wox-theme-icon-color)" stroke-linecap="round" stroke-opacity="${rowOpacity[row]}">${strokes}</g></svg>`
                  },
                  fit: "fill",
                  style: { width: rowWidth, height: dotSize }
                }
              }
            ]
          : []
      }
    })
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

export function playerTree(state: PlaybackState, favorite: boolean, locale = english, levels = waveLevels(playingSpectrum(state), tuningAge(state, Date.now()))): string {
  return playerDocument(state, favorite, locale, signalBand(levels))
}

function playerDocument(state: PlaybackState, favorite: boolean, locale: RadioLocale, signal: object): string {
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
        signal,
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
  onError: (error: unknown) => void,
  updateRadii?: (documentID: string, radii: number[]) => Promise<boolean>
) {
  let running = false
  let dirty = false
  let visible = false
  let frameTick: NodeJS.Timeout | undefined
  let sent: string | undefined
  let chrome: string | undefined
  let sentRadii: string | undefined
  let motion: { source: readonly number[] | string | undefined; from: number[]; to: number[]; startedAt: number; duration: number } | undefined
  const preview: PlayerViewPreview = {
    PreviewType: "woxview",
    get PreviewData() {
      if (sent !== undefined) return sent
      const { state, favorite, locale = english } = read()
      const levels = waveLevels(playingSpectrum(state), tuningAge(state, Date.now()))
      return playerDocument(state, favorite, locale, updateRadii ? signalChart(signalRadii(levels)) : signalBand(levels))
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
        clearTimeout(frameTick)
        sent = undefined
        chrome = undefined
        sentRadii = undefined
        motion = undefined
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
    clearTimeout(frameTick)
    running = true
    void (async () => {
      try {
        let animate = false
        while (visible && dirty) {
          dirty = false
          const { state, favorite, locale = english } = read()
          const now = Date.now()
          const age = tuningAge(state, now)
          const spectrum = playingSpectrum(state)
          const source = spectrum ?? (age === undefined ? undefined : `${state.tune?.startedAt}:${Math.floor(age / waveDuration)}`)
          let levels = motion?.to
          if (motion && motion.from !== motion.to && now < motion.startedAt + motion.duration) {
            const { from, to, startedAt, duration } = motion
            const progress = Math.max(0, (now - startedAt) / duration)
            levels = to.map((level, index) => from[index] + (level - from[index]) * progress)
          }
          if (!motion || motion.source !== source) {
            const to = waveLevels(spectrum, age)
            const spectrumAt = state.tune?.spectrumAt
            const duration = spectrumAt !== undefined && now - spectrumAt < handoffDuration ? handoffDuration : waveDuration
            motion = { source, from: levels ?? to, to, startedAt: now, duration }
          }
          animate = age !== undefined || (motion.from !== motion.to && now < motion.startedAt + motion.duration)
          const wave = levels ?? motion.to
          if (updateRadii) {
            const nextChrome = playerDocument(state, favorite, locale, { type: "spacer" })
            const radii = signalRadii(wave)
            const snapshot = JSON.stringify(radii)
            if (nextChrome === chrome) {
              if (snapshot !== sentRadii) {
                sentRadii = snapshot
                if (!(await updateRadii(preview.WoxViewID, radii))) {
                  chrome = undefined
                  return
                }
              }
              continue
            }
            chrome = nextChrome
            sentRadii = snapshot
            sent = playerDocument(state, favorite, locale, signalChart(radii))
            if (!(await update({ ...preview }))) {
              chrome = undefined
              sent = undefined
              return
            }
            continue
          }
          const data = playerTree(state, favorite, locale, wave)
          if (data !== sent) {
            sent = data
            if (!(await update({ ...preview }))) {
              sent = undefined
              return
            }
          }
        }
        if (visible && animate) frameTick = setTimeout(refresh, frameInterval).unref()
      } catch (error) {
        chrome = undefined
        sent = undefined
        onError(error)
      } finally {
        running = false
      }
    })()
  }
  return {
    preview,
    refresh,
    get initialPreview() {
      // The launcher retains the mounted preview while the user keeps typing.
      return updateRadii && visible ? undefined : preview
    }
  }
}
