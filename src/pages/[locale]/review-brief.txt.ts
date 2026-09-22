import type { APIRoute } from 'astro';
import { locales, useLocale } from '../../i18n';

export function getStaticPaths() {
  return locales.filter(locale => locale !== 'en').map(locale => ({ params: { locale } }));
}
export const GET: APIRoute = ({ url }) => {
  const { t } = useLocale(url);
  const text = [t('briefTitle'), t('brief1'), t('brief2'), t('brief3'), t('brief4'), t('brief5'), t('briefSend'), t('briefSafe')].join('\n') + '\n';
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
