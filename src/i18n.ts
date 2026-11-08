import enUS from "../lang/en_US.json"
import jaJP from "../lang/ja_JP.json"
import koKR from "../lang/ko_KR.json"
import ptBR from "../lang/pt_BR.json"
import ruRU from "../lang/ru_RU.json"
import zhCN from "../lang/zh_CN.json"
import { I18n as manifestTranslations } from "../plugin.json"

const catalogs = { en_US: enUS, zh_CN: zhCN, ru_RU: ruRU, pt_BR: ptBR, ko_KR: koKR, ja_JP: jaJP }
const defaultMessages = { ...enUS, ...manifestTranslations.en_US }
export type MessageKey = keyof typeof defaultMessages
type MessageValues = Record<string, string | number | RadioMessage>
export type RadioMessage = { key: MessageKey; values?: MessageValues }

const genres = new Map<string, MessageKey>([
  ["music", "genre_music"],
  ["news", "genre_news"],
  ["pop", "genre_pop"],
  ["rock", "genre_rock"],
  ["jazz", "genre_jazz"],
  ["classical", "genre_classical"],
  ["talk", "genre_talk"],
  ["oldies", "genre_oldies"]
])
const languages = new Map(
  Object.entries({
    arabic: "ar",
    chinese: "zh",
    dutch: "nl",
    english: "en",
    french: "fr",
    german: "de",
    hindi: "hi",
    italian: "it",
    japanese: "ja",
    korean: "ko",
    portuguese: "pt",
    russian: "ru",
    spanish: "es",
    turkish: "tr"
  })
)

function createLocale(messages: typeof defaultMessages) {
  const tag = messages.radio_locale
  const country = new Intl.DisplayNames(tag, { type: "region", fallback: "none" })
  const language = new Intl.DisplayNames(tag, { type: "language" })
  const number = new Intl.NumberFormat(tag)
  const percent = new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 0 })
  function t(key: MessageKey, values?: MessageValues): string {
    const template = messages[key] || defaultMessages[key]
    return values
      ? template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
          const value = values[name]
          if (typeof value === "number") return number.format(value)
          if (typeof value === "object") return t(value.key, value.values)
          return value ?? placeholder
        })
      : template
  }
  return {
    t,
    percent: (value: number) => percent.format(value / 100),
    country: (code: string, fallback: string) => (/^[A-Z]{2}$/.test(code) ? country.of(code) ?? fallback : fallback),
    language: (value: string) => {
      const code = languages.get(value.toLowerCase())
      return code ? language.of(code) ?? value : value
    },
    genre: (value: string) => {
      const key = genres.get(value.toLowerCase())
      return key ? t(key) : value
    }
  }
}

export type RadioLocale = ReturnType<typeof createLocale>
const locales = new Map((Object.keys(catalogs) as (keyof typeof catalogs)[]).map(code => [catalogs[code].radio_locale, createLocale({ ...catalogs[code], ...manifestTranslations[code] })]))
export const english = locales.get(enUS.radio_locale)!

export function radioLocale(tag: string): RadioLocale {
  return locales.get(tag) ?? english
}

export class RadioError extends Error {
  readonly notice: RadioMessage

  constructor(key: MessageKey, values?: MessageValues) {
    super(english.t(key, values))
    this.notice = { key, values }
  }
}
