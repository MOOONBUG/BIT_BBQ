import en from './en.json';
import ko from './ko.json';
import ja from './ja.json';
import zhHant from './zh-hant.json';
import ru from './ru.json';
import fr from './fr.json';

export const locales = ['en', 'ko', 'ja', 'zh-hant', 'ru', 'fr'] as const;
export type Locale = typeof locales[number];
export type MessageKey = keyof typeof en;
export const languages: Record<Locale, { name: string; short: string; tag: string; og: string }> = {
  en: { name: 'English', short: 'EN', tag: 'en', og: 'en_US' },
  ko: { name: '한국어', short: 'KO', tag: 'ko', og: 'ko_KR' },
  ja: { name: '日本語', short: 'JA', tag: 'ja', og: 'ja_JP' },
  'zh-hant': { name: '繁體中文', short: '繁', tag: 'zh-Hant', og: 'zh_TW' },
  ru: { name: 'Русский', short: 'RU', tag: 'ru', og: 'ru_RU' },
  fr: { name: 'Français', short: 'FR', tag: 'fr', og: 'fr_FR' },
};
export const pageSlugs = ['', 'sample', 'about', 'contact', 'free-review', 'privacy', 'terms'] as const;
const dictionaries: Record<Locale, Record<MessageKey, string>> = { en, ko, ja, 'zh-hant': zhHant, ru, fr };

export function getLocale(url: URL): Locale {
  const first = url.pathname.split('/')[1];
  return locales.find(locale => locale !== 'en' && locale === first) ?? 'en';
}

/** Strip only a supported language prefix, retaining the original page/anchor. */
export function localizePath(path: string, locale: Locale): string {
  const prefix = path.split('/')[1];
  const bare = locales.some(lang => lang !== 'en' && lang === prefix)
    ? path.slice(prefix.length + 1) || '/' : path;
  return locale === 'en' ? bare : `/${locale}${bare}`;
}

export function useLocale(url: URL) {
  const locale = getLocale(url);
  const t = (key: MessageKey): string => {
    const value = dictionaries[locale][key];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing translation: ${locale}.${key}`);
    return value;
  };
  return { locale, t, href: (path: string) => localizePath(path, locale) };
}
