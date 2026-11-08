/**
 * OAuth onboarding surface for the dashboard (client consent links).
 * Keeps the dashboard free of direct platform imports.
 */
export {
  AccessTokenCache,
  buildConsentUrl,
  exchangeCode,
  YT_READONLY_SCOPE,
  type OAuthAppConfig,
  YouTubeDataApi,
} from '@inbetween/adapter-youtube';
