import { describe, expect, it, vi } from 'vitest';
import { amzDateOf, EMPTY_PAYLOAD_HASH, rfc3986, signV4 } from '@/lib/aws-sigv4';
import { r2ConfigFromEnv, R2Storage } from '@/lib/r2';

/**
 * R2 드라이버 — SDK 없이 직접 서명하므로, 서명이 AWS 의 공개 테스트 벡터와 맞는지와
 * 세 요청(PUT · HEAD · GET Range)이 올바른 모양으로 나가는지를 고정합니다.
 */

describe('signV4 — AWS 테스트 벡터 (get-vanilla)', () => {
  /**
   * aws-sig-v4-test-suite 의 get-vanilla 케이스.
   *   GET / HTTP/1.1
   *   Host: example.amazonaws.com
   *   X-Amz-Date: 20150830T123600Z
   * 자격증명 AKIDEXAMPLE / wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY, us-east-1, 서비스 'service'
   */
  it('문서의 서명값과 바이트 단위로 같다', () => {
    const auth = signV4({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
      payloadHash: EMPTY_PAYLOAD_HASH,
      region: 'us-east-1',
      service: 'service',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      amzDate: '20150830T123600Z',
    });
    expect(auth).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('헤더는 소문자·이름순으로 정렬되고 값의 공백은 하나로 줄어든다', () => {
    const a = signV4({
      method: 'GET',
      url: new URL('https://h/'),
      headers: { Host: 'h', 'X-Amz-Date': '20150830T123600Z', Range: 'bytes=0-1' },
      payloadHash: EMPTY_PAYLOAD_HASH,
      region: 'auto',
      service: 's3',
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
      amzDate: '20150830T123600Z',
    });
    expect(a).toContain('SignedHeaders=host;range;x-amz-date');
  });

  it('amzDateOf 는 밀리초를 떼고 구분자를 뺀다', () => {
    expect(amzDateOf(new Date('2015-08-30T12:36:00.123Z'))).toBe('20150830T123600Z');
  });

  it("rfc3986 은 encodeURIComponent 가 남기는 !'()* 도 인코딩한다", () => {
    expect(rfc3986("a b!'()*~")).toBe('a%20b%21%27%28%29%2A~');
  });
});

describe('r2ConfigFromEnv', () => {
  const full = {
    R2_ACCOUNT_ID: 'acct',
    R2_ACCESS_KEY_ID: 'ak',
    R2_SECRET_ACCESS_KEY: 'sk',
    R2_BUCKET: 'bkt',
  };

  it('아무것도 없으면 null (로컬 디스크)', () => {
    expect(r2ConfigFromEnv({})).toBeNull();
  });

  it('넷이 다 있으면 기본 엔드포인트·prefix 를 채운다', () => {
    expect(r2ConfigFromEnv(full)).toEqual({
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      bucket: 'bkt',
      prefix: 'posts/',
      credentials: { accessKeyId: 'ak', secretAccessKey: 'sk' },
    });
  });

  it('일부만 있으면 조용히 로컬로 가지 않고 에러다', () => {
    expect(() => r2ConfigFromEnv({ R2_ACCOUNT_ID: 'acct' })).toThrow(/R2_BUCKET/);
  });

  it('prefix 는 끝에 / 가 붙고 앞의 / 는 떼며, 빈 문자열은 버킷 루트다', () => {
    expect(r2ConfigFromEnv({ ...full, R2_PREFIX: '/media' })?.prefix).toBe('media/');
    expect(r2ConfigFromEnv({ ...full, R2_PREFIX: '' })?.prefix).toBe('');
    expect(r2ConfigFromEnv({ ...full, R2_ENDPOINT: 'https://x.example/' })?.endpoint).toBe('https://x.example');
  });
});

describe('R2Storage', () => {
  const cfg = {
    endpoint: 'https://acct.r2.cloudflarestorage.com',
    bucket: 'bkt',
    prefix: 'posts/',
    credentials: { accessKeyId: 'ak', secretAccessKey: 'sk' },
  };
  const now = () => new Date('2026-09-16T00:00:00Z');

  function client(handler: (url: string, init: RequestInit) => Response) {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => handler(url, init));
    return { storage: new R2Storage(cfg, fetchImpl, now), fetchImpl };
  }

  it('객체 주소는 경로 방식이고 prefix 가 붙는다', () => {
    const { storage } = client(() => new Response(null));
    expect(storage.objectUrl('abc.jpg').toString()).toBe('https://acct.r2.cloudflarestorage.com/bkt/posts/abc.jpg');
  });

  it('size — HEAD 의 content-length 를 돌려주고 404 는 null', async () => {
    const { storage, fetchImpl } = client((_url, init) =>
      init.method === 'HEAD' ? new Response(null, { status: 200, headers: { 'content-length': '1234' } }) : new Response(null, { status: 500 }),
    );
    expect(await storage.size('abc.jpg')).toBe(1234);
    const [, init] = fetchImpl.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=ak\/20260916\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(headers['x-amz-date']).toBe('20260916T000000Z');
    expect(headers['x-amz-content-sha256']).toBe(EMPTY_PAYLOAD_HASH);
    expect(headers.host).toBeUndefined(); // fetch 가 스스로 붙인다

    const missing = client(() => new Response(null, { status: 404 }));
    expect(await missing.storage.size('nope.jpg')).toBeNull();
  });

  it('put — 이미 있으면 PUT 하지 않고, 없으면 content-type 과 본문 해시를 서명에 넣어 올린다', async () => {
    const body = Buffer.from('hello');
    const hash = 'deadbeef';

    const exists = client(() => new Response(null, { status: 200, headers: { 'content-length': '5' } }));
    await exists.storage.put('k.jpg', body, 'image/jpeg', hash);
    expect(exists.fetchImpl.mock.calls.map(([, i]) => i.method)).toEqual(['HEAD']);

    const fresh = client((_url, init) =>
      init.method === 'HEAD' ? new Response(null, { status: 404 }) : new Response(null, { status: 200 }),
    );
    await fresh.storage.put('k.jpg', body, 'image/jpeg', hash);
    expect(fresh.fetchImpl.mock.calls.map(([, i]) => i.method)).toEqual(['HEAD', 'PUT']);
    const put = fresh.fetchImpl.mock.calls[1][1];
    const h = put.headers as Record<string, string>;
    expect(h['content-type']).toBe('image/jpeg');
    expect(h['x-amz-content-sha256']).toBe(hash);
    expect(h.authorization).toContain('SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date');
    expect(Buffer.from(put.body as Uint8Array).toString()).toBe('hello');
  });

  it('put — R2 가 거절하면 상태 코드와 본문 앞부분을 담은 에러다', async () => {
    const { storage } = client((_url, init) =>
      init.method === 'HEAD' ? new Response(null, { status: 404 }) : new Response('<Error>AccessDenied</Error>', { status: 403 }),
    );
    await expect(storage.put('k.jpg', Buffer.from('x'), 'image/jpeg', 'h')).rejects.toThrow(/PUT k\.jpg → 403 <Error>AccessDenied/);
  });

  it('stream — Range 헤더를 그대로 넘기고 서명에 포함한다', async () => {
    const { storage, fetchImpl } = client(() => new Response('bc', { status: 206 }));
    const stream = await storage.stream('k.mp4', { start: 1, end: 2 });
    expect(stream).not.toBeNull();
    const h = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    expect(h.range).toBe('bytes=1-2');
    expect(h.authorization).toContain('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date');
    expect(await new Response(stream!).text()).toBe('bc');
  });

  it('stream · read — 404 는 null', async () => {
    const { storage } = client(() => new Response(null, { status: 404 }));
    expect(await storage.stream('k.mp4')).toBeNull();
    expect(await storage.read('k.mp4')).toBeNull();
  });
});
