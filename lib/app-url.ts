/** 끝의 `/` 를 떼어 주소를 한 모양으로 맞춥니다 */
const trimSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * 설정으로 정해진 바깥 주소. 정할 수 없으면 null 입니다.
 *
 * 순서가 둘입니다.
 *   1. `APP_URL` — 직접 못박은 값. 언제나 이것이 먼저입니다.
 *   2. `VERCEL_PROJECT_PRODUCTION_URL` — Vercel 이 넣어 주는 **운영 도메인**
 *      (프로토콜 없이 `myapp.vercel.app` 꼴). Vercel 에서는 이 값이 곧 정답이라
 *      APP_URL 을 따로 넣지 않아도 됩니다. 미리보기 배포에서도 운영 도메인을
 *      가리키는데, OAuth 콜백·인증 메일 링크는 콘솔에 등록해 둔 **한 주소**로
 *      나가야 하므로 그쪽이 맞습니다.
 *
 * 헤더(Host)로 유추하지 않습니다 — 그건 appOrigin 의 마지막 수단입니다.
 */
export function configuredAppUrl(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env.APP_URL?.trim();
  if (explicit) return trimSlash(explicit);

  const vercel = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return trimSlash(vercel.startsWith('http') ? vercel : `https://${vercel}`);

  return null;
}

/**
 * 바깥에서 보이는 앱 주소 (metadata · robots · sitemap · OG).
 *
 * 운영에서는 APP_URL 이 필수입니다(lib/env-check.ts) — 단, Vercel 에서는 플랫폼이
 * 주는 운영 도메인으로 대신합니다(configuredAppUrl). 빌드 시점·개발에서는 없을 수
 * 있어 localhost 로 떨어집니다 — 그 값이 sitemap 에 박히면 안 되므로 그 밖의 곳에서는
 * 반드시 채우세요. OAuth 콜백 주소도 같은 값을 씁니다 (lib/oauth.ts).
 */
export function publicAppUrl(): string {
  return configuredAppUrl() ?? 'http://localhost:3000';
}

/**
 * 요청 기준의 바깥 주소 — **밖으로 나갔다가 돌아오는 길**을 만들 때 씁니다.
 * OAuth 콜백(lib/oauth.ts redirectUri)과 인증 메일의 링크(lib/email-verify.ts)가
 * 그렇습니다. 둘이 서로 다른 방식으로 주소를 짐작하면 한쪽만 조용히 어긋납니다.
 *
 * 위 publicAppUrl 과 나눠 둔 이유: 그쪽은 요청이 없는 자리(metadata·sitemap·OG)에서
 * 불리므로 APP_URL 하나만 봅니다. 여기는 요청이 있어 헤더로 유추할 수 있지만,
 * 그건 **마지막 수단**입니다 — 프록시 뒤에서는 Host 가 내부 주소일 수 있고, 그러면
 * OAuth 는 등록해 둔 주소와 달라 실패하고 메일 링크는 열 수 없는 주소로 나갑니다.
 * 운영에서는 APP_URL 을 못박으세요 (lib/env-check.ts 가 없으면 기동을 막습니다).
 */
export function appOrigin(request: Request): string {
  const configured = configuredAppUrl() ?? process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return trimSlash(configured);

  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const host =
    request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ?? request.headers.get('host');
  if (host) return `${proto || 'http'}://${host}`;
  return new URL(request.url).origin;
}
