import en from './micro-en.json';
import ko from './micro-ko.json';
import ja from './micro-ja.json';
import zh from './micro-zh-hant.json';
import ru from './micro-ru.json';
import fr from './micro-fr.json';
import type { Locale } from './index';
export const microCopy: Record<Locale, typeof en> = { en, ko, ja, 'zh-hant': zh, ru, fr };
