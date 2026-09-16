/**
 * 운영 필수 환경변수를 **서버가 뜰 때** 한 번에 봅니다 (instrumentation.ts 가 부릅니다).
 *
 * 2026-09-13 QA 에서 확인한 것: 빠진 값이 전부 **요청 시점**에 드러났습니다.
 *   - AUTH_SECRET 없음    → 쿠키 없는 방문자는 정상, 로그인·권한 확인만 500
 *   - ADMIN_PASSWORD 없음 → 일반 사용자 로그인까지 503 (R11)
 *   - APP_URL 없음        → 프록시 뒤에서 OAuth 콜백 주소가 내부 주소로 잡혀 토큰 교환 실패
 *   - DATABASE_URL 없음   → 시드로 만든 PGlite 로 "정상" 기동
 *   - TRUSTED_PROXY_HOPS 없음 → 가입 시도 제한이 0 (lib/auth.ts clientKey 가 null)
 * 전부 "배포는 성공했는데 누군가 로그인을 시도할 때" 알게 되는 것들입니다.
 * 뜰 때 죽는 쪽이 낫습니다 — 클러스터가 백오프로 재기동하며 로그에 이유가 남습니다.
 *
 * 순수 함수로 두고 env 객체를 인자로 받는 이유는 테스트입니다 (tests/env-check.test.ts).
 */
import { configuredAppUrl } from './app-url';

export interface EnvCheckResult {
  /** 이것이 하나라도 있으면 기동하지 않아야 합니다 */
  errors: string[];
  /** 기동은 하되 로그에 남길 것 */
  warnings: string[];
}

const MIN_SECRET_LENGTH = 16;

/** process.env 모양 — Next 의 타입은 NODE_ENV 를 필수로 두므로 테스트가 부분 객체를 넘길 수 있게 느슨하게 받습니다 */
export type EnvLike = Record<string, string | undefined>;

/**
 * 앞에 둔 **신뢰하는** 프록시 홉 수. 기본 0 — 프록시가 없다는 뜻입니다.
 * 실제로 이 값을 쓰는 곳은 lib/auth.ts clientKey 이고, 아래 기동 검사와 **같은 함수**를
 * 봅니다 — 따로 두면 "검사는 통과했는데 실제로는 0" 이 조용히 생깁니다.
 *
 * Vercel 에서는 엣지 한 대가 언제나 앞에 있어 1 입니다. 플랫폼이 넣어 주는 `VERCEL` 로
 * 알아냅니다 — 사람이 적어 넣을 값을 줄이려는 것이지 느슨하게 하려는 것이 아닙니다.
 * 홉 수를 **실제로 아는** 경우에만 기본값을 줍니다.
 */
export function trustedProxyHops(env: EnvLike = process.env): number {
  const raw = Number(env.TRUSTED_PROXY_HOPS);
  if (Number.isInteger(raw) && raw > 0) return raw;
  if (env.VERCEL) return 1;
  return 0;
}

export function checkProductionEnv(env: EnvLike = process.env): EnvCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (env.NODE_ENV !== 'production') return { errors, warnings };

  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < MIN_SECRET_LENGTH) {
    errors.push(
      `AUTH_SECRET 이 없거나 ${MIN_SECRET_LENGTH}자보다 짧습니다 — 세션 쿠키를 서명할 수 없어 로그인이 500 으로 끝납니다`,
    );
  }

  if (!env.DATABASE_URL) {
    errors.push('DATABASE_URL 이 없습니다 — 운영에서 PGlite(시드 데이터)로 뜨면 안 됩니다');
  }

  if (!env.ADMIN_PASSWORD) {
    errors.push('ADMIN_PASSWORD 가 없습니다 — /api/auth/login 이 모든 사용자에게 503 을 돌려줍니다');
  }

  // Vercel 에서는 플랫폼이 주는 운영 도메인이 곧 정답이라 APP_URL 을 따로 안 넣어도 됩니다.
  const appUrl = configuredAppUrl(env);
  if (!appUrl) {
    errors.push('APP_URL 이 없습니다 — OAuth 콜백 주소를 Host 헤더로 유추하면 프록시 뒤에서 어긋납니다');
  } else {
    try {
      const url = new URL(appUrl);
      if (url.protocol !== 'https:') {
        warnings.push(`APP_URL 이 https 가 아닙니다 (${url.protocol}) — 세션 쿠키가 Secure 라 http 에서는 저장되지 않습니다`);
      }
    } catch {
      errors.push(`APP_URL 이 URL 형식이 아닙니다: ${appUrl}`);
    }
  }

  // Vercel 은 엣지 한 대가 앞에 있어 1 입니다 (trustedProxyHops).
  if (trustedProxyHops(env) < 1) {
    errors.push(
      'TRUSTED_PROXY_HOPS 가 1 이상이어야 합니다 — 없으면 클라이언트 주소를 모르므로 가입·익명 제보 시도 제한이 0 입니다 (npm run start:cluster 는 자동으로 1 을 넣습니다)',
    );
  }

  if (env.DB_FALLBACK && env.DB_FALLBACK !== 'off') {
    warnings.push('DB_FALLBACK 이 켜져 있습니다 — Postgres 가 끊기면 인스턴스마다 다른 사본에 씁니다. 운영에서는 off 를 권합니다');
  }

  // 첨부 저장소. 넷 중 일부만 있으면 lib/r2.ts 가 첫 업로드에서 에러를 내므로 여기서 먼저 잡는다.
  const r2Keys = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const;
  const r2Given = r2Keys.filter((k) => env[k]?.trim());
  if (r2Given.length === 0) {
    warnings.push(
      'R2_* 가 없습니다 — 첨부가 로컬 디스크(uploads/posts/)에 저장됩니다. Vercel 같은 서버리스에서는 쓰기가 실패하거나 배포마다 사라집니다',
    );
  } else if (r2Given.length < r2Keys.length) {
    errors.push(
      `R2 설정이 일부만 있습니다 (${r2Given.join(', ')}) — ${r2Keys.join(' · ')} 넷이 다 있어야 첨부 업로드가 됩니다`,
    );
  }

  if (!env.NEXT_PUBLIC_NAVER_MAP_KEY_ID) {
    warnings.push('NEXT_PUBLIC_NAVER_MAP_KEY_ID 가 없습니다 — 지도가 FallbackMap 으로 뜹니다 (빌드 시점 값이라 재빌드가 필요합니다)');
  }

  if (!env.GEMINI_API_KEY) {
    warnings.push('GEMINI_API_KEY 가 없습니다 — 챗봇 자유 질문이 503 입니다');
  }

  return { errors, warnings };
}

/**
 * 결과를 로그로 옮기고, 오류가 있으면 프로세스를 끝냅니다.
 * `next build` 의 정적 생성 단계(NEXT_PHASE=phase-production-build)에서는 보지 않습니다 —
 * 빌드 머신에는 운영 비밀이 없는 것이 정상입니다.
 */
export function enforceProductionEnv(env: EnvLike = process.env): void {
  if (env.NEXT_PHASE === 'phase-production-build') return;
  // 로컬에서 운영 빌드를 잠깐 띄워 볼 때(PWA 확인 등)의 탈출구. 운영 배포에서는 절대 켜지 마세요.
  if (env.ENV_CHECK === 'off') {
    console.warn('[env] ⚠ ENV_CHECK=off — 운영 필수 설정 검사를 건너뜁니다. 실제 배포에서는 켜 두세요.');
    return;
  }
  const { errors, warnings } = checkProductionEnv(env);
  for (const w of warnings) console.warn(`[env] ⚠ ${w}`);
  if (errors.length === 0) return;
  for (const e of errors) console.error(`[env] ✗ ${e}`);
  console.error(`[env] 운영 필수 설정 ${errors.length}건이 빠져 기동하지 않습니다 (.env.example 참고)`);
  process.exit(1);
}
