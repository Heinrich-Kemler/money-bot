export const DEFAULT_PUBLIC_BASE_URL = "http://localhost:8787";

export function publicBaseUrl(env: { PUBLIC_BASE_URL?: string }): string {
  const raw = env.PUBLIC_BASE_URL?.trim();
  if (!raw) {
    return DEFAULT_PUBLIC_BASE_URL;
  }
  return raw.replace(/\/$/, "");
}
