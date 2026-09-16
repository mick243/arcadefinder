import { describe, expect, it } from 'vitest';
import { configuredAppUrl } from '@/lib/app-url';
import { checkProductionEnv, trustedProxyHops } from '@/lib/env-check';

/**
 * 운영 필수 설정 검사 — **무엇이 빠졌을 때 기동을 막는가**를 고정합니다.
 *
 * 이 목록은 QA 에서 "요청 시점에야 드러났던" 것들입니다. 항목을 빼면 그 사고가
 * 조용히 돌아오므로, 하나씩 빠졌을 때 오류가 나는지 봅니다.
 */

const good = {
  NODE_ENV: 'production',
  AUTH_SECRET: 'x'.repeat(32),
  DATABASE_URL: 'postgresql://u:p@db:5432/arcade',
  ADMIN_PASSWORD: 'correct horse battery staple',
  APP_URL: 'https://arcade.example.com',
  TRUSTED_PROXY_HOPS: '1',
  NEXT_PUBLIC_NAVER_MAP_KEY_ID: 'key',
  GEMINI_API_KEY: 'gk',
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'ak',
  R2_SECRET_ACCESS_KEY: 'sk',
  R2_BUCKET: 'arcade-finder',
} satisfies Record<string, string>;

describe('checkProductionEnv', () => {
  it('개발·테스트에서는 아무것도 요구하지 않는다', () => {
    expect(checkProductionEnv({ NODE_ENV: 'test' })).toEqual({ errors: [], warnings: [] });
    expect(checkProductionEnv({})).toEqual({ errors: [], warnings: [] });
  });

  it('필수값이 다 있으면 오류가 없다', () => {
    expect(checkProductionEnv(good).errors).toEqual([]);
  });

  it.each([
    ['AUTH_SECRET', 'AUTH_SECRET'],
    ['DATABASE_URL', 'DATABASE_URL'],
    ['ADMIN_PASSWORD', 'ADMIN_PASSWORD'],
    ['APP_URL', 'APP_URL'],
    ['TRUSTED_PROXY_HOPS', 'TRUSTED_PROXY_HOPS'],
  ])('%s 가 없으면 기동을 막는다', (key, mentioned) => {
    const env = { ...good } as Record<string, string | undefined>;
    delete env[key];
    const { errors } = checkProductionEnv(env);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(mentioned);
  });

  it('AUTH_SECRET 이 짧으면 없는 것과 같다', () => {
    expect(checkProductionEnv({ ...good, AUTH_SECRET: 'short' }).errors[0]).toContain('AUTH_SECRET');
  });

  it('TRUSTED_PROXY_HOPS=0 은 프록시가 없다는 뜻이라 막는다', () => {
    expect(checkProductionEnv({ ...good, TRUSTED_PROXY_HOPS: '0' }).errors[0]).toContain('TRUSTED_PROXY_HOPS');
  });

  it('APP_URL 이 URL 이 아니면 막고, http 면 경고만 한다', () => {
    expect(checkProductionEnv({ ...good, APP_URL: 'not a url' }).errors[0]).toContain('APP_URL');
    const http = checkProductionEnv({ ...good, APP_URL: 'http://arcade.example.com' });
    expect(http.errors).toEqual([]);
    expect(http.warnings.some((w) => w.includes('https'))).toBe(true);
  });

  it('DB_FALLBACK 을 켜 두면 경고한다 — 운영 기본은 off', () => {
    expect(checkProductionEnv({ ...good, DB_FALLBACK: 'on' }).warnings.some((w) => w.includes('DB_FALLBACK'))).toBe(true);
    expect(checkProductionEnv({ ...good, DB_FALLBACK: 'off' }).warnings.some((w) => w.includes('DB_FALLBACK'))).toBe(false);
  });

  /**
   * Vercel 은 운영 도메인과 엣지 홉 수를 스스로 알려줍니다. 사람이 적어 넣을 값을
   * 줄이는 것이 목적이고, 알 수 없는 곳에서는 예전처럼 막아야 합니다.
   */
  it('Vercel 에서는 APP_URL·TRUSTED_PROXY_HOPS 를 안 넣어도 된다', () => {
    const onVercel = {
      ...good,
      APP_URL: undefined,
      TRUSTED_PROXY_HOPS: undefined,
      VERCEL: '1',
      VERCEL_PROJECT_PRODUCTION_URL: 'arcadefinder.vercel.app',
    };
    expect(checkProductionEnv(onVercel).errors).toEqual([]);
  });

  it('Vercel 이 아니면 여전히 둘 다 필수다', () => {
    const { errors } = checkProductionEnv({ ...good, APP_URL: undefined, TRUSTED_PROXY_HOPS: undefined });
    expect(errors).toHaveLength(2);
    expect(errors.join(' ')).toContain('APP_URL');
    expect(errors.join(' ')).toContain('TRUSTED_PROXY_HOPS');
  });

  it('직접 적은 APP_URL 이 플랫폼 값보다 우선한다', () => {
    expect(
      configuredAppUrl({ APP_URL: 'https://arcade.example.com/', VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app' }),
    ).toBe('https://arcade.example.com');
    expect(configuredAppUrl({ VERCEL_PROJECT_PRODUCTION_URL: 'x.vercel.app' })).toBe('https://x.vercel.app');
    expect(configuredAppUrl({})).toBeNull();
  });

  it('홉 수는 적어 준 값이 먼저이고, Vercel 기본은 1, 그 밖은 0 이다', () => {
    expect(trustedProxyHops({ TRUSTED_PROXY_HOPS: '2', VERCEL: '1' })).toBe(2);
    expect(trustedProxyHops({ VERCEL: '1' })).toBe(1);
    expect(trustedProxyHops({})).toBe(0);
  });

  it('R2 가 없으면 경고만 하고(로컬 디스크), 일부만 있으면 막는다', () => {
    const none = checkProductionEnv({
      ...good,
      R2_ACCOUNT_ID: undefined,
      R2_ACCESS_KEY_ID: undefined,
      R2_SECRET_ACCESS_KEY: undefined,
      R2_BUCKET: undefined,
    });
    expect(none.errors).toEqual([]);
    expect(none.warnings.some((w) => w.includes('R2_'))).toBe(true);

    const partial = checkProductionEnv({ ...good, R2_BUCKET: undefined });
    expect(partial.errors).toHaveLength(1);
    expect(partial.errors[0]).toContain('R2_BUCKET');
  });

  it('지도 키·Gemini 키는 없어도 뜬다 (경고)', () => {
    const { errors, warnings } = checkProductionEnv({
      ...good,
      NEXT_PUBLIC_NAVER_MAP_KEY_ID: undefined,
      GEMINI_API_KEY: undefined,
    });
    expect(errors).toEqual([]);
    expect(warnings).toHaveLength(2);
  });
});
