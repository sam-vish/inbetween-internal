/**
 * OAuth onboarding surface for the dashboard (client consent links).
 * Imports only the lightweight OAuth + Data API modules (no gRPC), and keeps
 * the dashboard free of direct platform imports.
 */
export { AccessTokenCache, buildConsentUrl, exchangeCode, YT_READONLY_SCOPE, type OAuthAppConfig } from '@inbetween/adapter-youtube/oauth';
export { YouTubeDataApi } from '@inbetween/adapter-youtube/api';
