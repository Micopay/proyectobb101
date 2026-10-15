import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import es from './es.json';
import en from './en.json';

const saved = localStorage.getItem('micopay_lang') ?? 'es';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      es: { translation: es },
      en: { translation: en },
    },
    lng: saved,
    fallbackLng: 'es',
    interpolation: { escapeValue: false },
  });

export function setLanguage(lang: 'es' | 'en') {
  i18n.changeLanguage(lang);
  localStorage.setItem('micopay_lang', lang);
}

export default i18n;
