import crypto from 'node:crypto';

/**
 * AWS Signature Version 4 — S3 호환 저장소(Cloudflare R2)에 요청을 서명합니다.
 *
 * SDK(@aws-sdk/client-s3) 를 들이지 않는 이유는 lib/mailer.ts 와 같습니다 — 패키지가
 * 0개 늘고, 우리가 쓰는 것은 PUT · HEAD · GET(Range) 세 가지뿐입니다. 서명 절차는
 * 문서(docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html)
 * 를 그대로 옮겼고, tests/r2.test.ts 가 AWS 의 공개 테스트 벡터(get-vanilla)로 고정합니다.
 *
 * 쿼리 문자열은 다루지 않습니다 — 우리 요청에는 쿼리가 없습니다.
 */

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SigV4Input {
  method: string;
  /** 요청 URL. 경로의 각 구간을 RFC 3986 으로 인코딩해 canonical URI 를 만듭니다 */
  url: URL;
  /** 서명에 넣을 헤더. host 를 포함해야 하고, 여기 든 것은 요청에도 **그대로** 실려야 합니다 */
  headers: Record<string, string>;
  /** 본문의 SHA-256(hex). 본문이 없으면 EMPTY_PAYLOAD_HASH */
  payloadHash: string;
  region: string;
  service: string;
  credentials: SigV4Credentials;
  /** `x-amz-date` 값 (YYYYMMDD'T'HHMMSS'Z'). headers 에 든 것과 같아야 합니다 */
  amzDate: string;
}

export const EMPTY_PAYLOAD_HASH = crypto.createHash('sha256').update('').digest('hex');

export const sha256Hex = (data: Buffer | string): string =>
  crypto.createHash('sha256').update(data).digest('hex');

const hmac = (key: Buffer | string, data: string): Buffer =>
  crypto.createHmac('sha256', key).update(data, 'utf8').digest();

/** `Date` → x-amz-date 형식 */
export function amzDateOf(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * RFC 3986 인코딩 — `encodeURIComponent` 가 남기는 `!'()*` 까지 인코딩합니다.
 * S3 는 canonical URI 에서 이 규칙을 요구합니다.
 */
export function rfc3986(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalUri(pathname: string): string {
  if (pathname === '' || pathname === '/') return '/';
  // URL.pathname 은 이미 퍼센트 인코딩된 상태라, 구간마다 되돌린 뒤 다시 인코딩한다.
  return pathname
    .split('/')
    .map((seg) => rfc3986(decodeURIComponent(seg)))
    .join('/');
}

/** Authorization 헤더 값 */
export function signV4(input: SigV4Input): string {
  const { method, url, headers, payloadHash, region, service, credentials, amzDate } = input;

  const lowered = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const canonicalHeaders = lowered.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = lowered.map(([k]) => k).join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(url.pathname),
    '', // canonical query string — 쿼리는 쓰지 않는다
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  return `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}
