import { amzDateOf, EMPTY_PAYLOAD_HASH, rfc3986, signV4, type SigV4Credentials } from './aws-sigv4';

/**
 * Cloudflare R2 (S3 호환) 객체 저장소 — 첨부 파일의 운영 저장소.
 *
 * lib/uploads.ts 가 R2_* 환경변수가 다 있을 때만 이 드라이버를 고릅니다. 없으면
 * 예전처럼 로컬 `uploads/posts/` 에 씁니다 (개발 기본값). Vercel 같은 서버리스에서는
 * 파일시스템이 읽기 전용이거나 배포마다 비워지므로 **운영에서는 이쪽이 필수**입니다
 * (lib/env-check.ts 가 없으면 경고합니다).
 *
 * 쓰는 요청은 셋뿐입니다.
 *   PUT  /{bucket}/{key}          저장 (본문 SHA-256 을 서명에 넣는다 — 키가 이미 그 해시다)
 *   HEAD /{bucket}/{key}          크기 · 존재 확인
 *   GET  /{bucket}/{key} + Range  내려받기 (동영상 구간 요청은 그대로 R2 로 넘긴다)
 *
 * 경로 방식(path-style) 주소를 씁니다 — R2 문서의 기본 형태이고, 버킷 이름에
 * 점이 있어도 TLS 가 깨지지 않습니다.
 */

export interface R2Config {
  endpoint: string; // https://<account>.r2.cloudflarestorage.com
  bucket: string;
  /** 객체 키 앞에 붙는 폴더. 끝에 / 를 포함한다 (예: 'posts/'). 빈 문자열이면 버킷 루트 */
  prefix: string;
  credentials: SigV4Credentials;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * 환경변수에서 설정을 읽습니다. 네 값(계정 · 키 ID · 비밀 키 · 버킷)이 모두 있어야
 * 켜집니다 — 일부만 있으면 "설정하려다 만" 것이라 로컬로 조용히 내려가지 않고
 * 에러를 냅니다.
 */
export function r2ConfigFromEnv(env: Record<string, string | undefined> = process.env): R2Config | null {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = env.R2_BUCKET?.trim();
  const given = [accountId, accessKeyId, secretAccessKey, bucket].filter(Boolean).length;
  if (given === 0) return null;
  if (given < 4 || !accountId || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      'R2 설정이 일부만 있습니다 — R2_ACCOUNT_ID · R2_ACCESS_KEY_ID · R2_SECRET_ACCESS_KEY · R2_BUCKET 넷이 다 있어야 합니다 (.env.example 참고)',
    );
  }
  const endpoint = (env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
  let prefix = (env.R2_PREFIX ?? 'posts/').replace(/^\/+/, '');
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  return { endpoint, bucket, prefix, credentials: { accessKeyId, secretAccessKey } };
}

export class R2Storage {
  constructor(
    private readonly cfg: R2Config,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly now: () => Date = () => new Date(),
  ) {}

  objectUrl(key: string): URL {
    const path = `${this.cfg.prefix}${key}`.split('/').map(rfc3986).join('/');
    return new URL(`${this.cfg.endpoint}/${rfc3986(this.cfg.bucket)}/${path}`);
  }

  private async request(
    method: 'PUT' | 'HEAD' | 'GET',
    key: string,
    opts: { body?: Buffer; payloadHash?: string; extraHeaders?: Record<string, string> } = {},
  ): Promise<Response> {
    const url = this.objectUrl(key);
    const amzDate = amzDateOf(this.now());
    const payloadHash = opts.payloadHash ?? EMPTY_PAYLOAD_HASH;
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...opts.extraHeaders,
    };
    const authorization = signV4({
      method,
      url,
      headers,
      payloadHash,
      region: 'auto',
      service: 's3',
      credentials: this.cfg.credentials,
      amzDate,
    });
    // host 는 fetch 가 스스로 붙인다 — 직접 넣으면 undici 가 거부한다.
    const { host: _host, ...sendHeaders } = headers;
    // Buffer 를 복사 없이 그대로 보낸다 (50MB 동영상을 한 번 더 복사하지 않기 위해).
    // ArrayBufferLike 캐스트는 타입만 — Buffer 는 SharedArrayBuffer 위에 만들지 않는다.
    const body = opts.body
      ? new Uint8Array(opts.body.buffer as ArrayBuffer, opts.body.byteOffset, opts.body.byteLength)
      : undefined;
    return this.fetchImpl(url.toString(), { method, headers: { ...sendHeaders, authorization }, body });
  }

  /** 객체 크기. 없으면 null */
  async size(key: string): Promise<number | null> {
    const res = await this.request('HEAD', key);
    if (res.status === 404) return null;
    if (!res.ok) throw await this.error('HEAD', key, res);
    const len = Number(res.headers.get('content-length'));
    return Number.isFinite(len) ? len : null;
  }

  /** 저장. 같은 키가 이미 있으면(내용 해시라 내용도 같다) 다시 올리지 않는다 */
  async put(key: string, body: Buffer, mime: string, sha256Hex: string): Promise<void> {
    if ((await this.size(key)) !== null) return;
    const res = await this.request('PUT', key, {
      body,
      payloadHash: sha256Hex,
      extraHeaders: { 'content-type': mime },
    });
    if (!res.ok) throw await this.error('PUT', key, res);
  }

  /** 전체 또는 구간을 스트림으로. 없으면 null */
  async stream(
    key: string,
    range?: { start: number; end: number },
  ): Promise<ReadableStream<Uint8Array> | null> {
    const res = await this.request('GET', key, {
      extraHeaders: range ? { range: `bytes=${range.start}-${range.end}` } : undefined,
    });
    if (res.status === 404) return null;
    if (!res.ok || !res.body) throw await this.error('GET', key, res);
    return res.body as ReadableStream<Uint8Array>;
  }

  /** 통째로 읽기. 없으면 null (작은 파일 전용 — 동영상은 stream 을 쓴다) */
  async read(key: string): Promise<Buffer | null> {
    const res = await this.request('GET', key);
    if (res.status === 404) return null;
    if (!res.ok) throw await this.error('GET', key, res);
    return Buffer.from(await res.arrayBuffer());
  }

  private async error(method: string, key: string, res: Response): Promise<Error> {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* 본문이 없어도 상태 코드만으로 충분하다 */
    }
    return new Error(`[r2] ${method} ${key} → ${res.status}${detail ? ` ${detail}` : ''}`);
  }
}
