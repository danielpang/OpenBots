import { describe, expect, it } from 'vitest';
import { canonicalRequest, signature, stringToSign, verifySigV4 } from './test-sigv4.js';

// The stand-in's SigV4 verifier against AWS's own published examples
// ("Signature Calculations for the Authorization Header: Transferring
// Payload in a Single Chunk", Amazon S3 API reference): the same requests
// must give the same canonical request, string to sign and signature.

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const base = {
  secretAccessKey: SECRET,
  region: 'us-east-1',
  service: 's3',
  amzDate: '20130524T000000Z',
};

const examples = [
  {
    name: 'GET Object',
    method: 'GET',
    url: '/test.txt',
    headers: {
      host: 'examplebucket.s3.amazonaws.com',
      range: 'bytes=0-9',
      'x-amz-content-sha256': EMPTY,
      'x-amz-date': '20130524T000000Z',
    },
    signedHeaders: ['host', 'range', 'x-amz-content-sha256', 'x-amz-date'],
    canonical: [
      'GET',
      '/test.txt',
      '',
      'host:examplebucket.s3.amazonaws.com',
      'range:bytes=0-9',
      `x-amz-content-sha256:${EMPTY}`,
      'x-amz-date:20130524T000000Z',
      '',
      'host;range;x-amz-content-sha256;x-amz-date',
      EMPTY,
    ].join('\n'),
    toSign: [
      'AWS4-HMAC-SHA256',
      '20130524T000000Z',
      '20130524/us-east-1/s3/aws4_request',
      '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972',
    ].join('\n'),
    signature: 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  },
  {
    name: 'PUT Object',
    method: 'PUT',
    url: '/test$file.text',
    headers: {
      host: 'examplebucket.s3.amazonaws.com',
      date: 'Fri, 24 May 2013 00:00:00 GMT',
      'x-amz-date': '20130524T000000Z',
      'x-amz-storage-class': 'REDUCED_REDUNDANCY',
      'x-amz-content-sha256': '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    },
    signedHeaders: ['date', 'host', 'x-amz-content-sha256', 'x-amz-date', 'x-amz-storage-class'],
    canonical: [
      'PUT',
      '/test%24file.text',
      '',
      'date:Fri, 24 May 2013 00:00:00 GMT',
      'host:examplebucket.s3.amazonaws.com',
      'x-amz-content-sha256:44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
      'x-amz-date:20130524T000000Z',
      'x-amz-storage-class:REDUCED_REDUNDANCY',
      '',
      'date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class',
      '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    ].join('\n'),
    toSign: [
      'AWS4-HMAC-SHA256',
      '20130524T000000Z',
      '20130524/us-east-1/s3/aws4_request',
      '9e0e90d9c76de8fa5b200d8c849cd5b8dc7a3be3951ddb7f6a76b4158342019d',
    ].join('\n'),
    signature: '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
  },
  {
    name: 'GET Bucket Lifecycle',
    method: 'GET',
    url: '/?lifecycle',
    headers: {
      host: 'examplebucket.s3.amazonaws.com',
      'x-amz-date': '20130524T000000Z',
      'x-amz-content-sha256': EMPTY,
    },
    signedHeaders: ['host', 'x-amz-content-sha256', 'x-amz-date'],
    canonical: [
      'GET',
      '/',
      'lifecycle=',
      'host:examplebucket.s3.amazonaws.com',
      `x-amz-content-sha256:${EMPTY}`,
      'x-amz-date:20130524T000000Z',
      '',
      'host;x-amz-content-sha256;x-amz-date',
      EMPTY,
    ].join('\n'),
    toSign: [
      'AWS4-HMAC-SHA256',
      '20130524T000000Z',
      '20130524/us-east-1/s3/aws4_request',
      '9766c798316ff2757b517bc739a67f6213b4ab36dd5da2f94eaebf79c77395ca',
    ].join('\n'),
    signature: 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
  },
  {
    name: 'GET Bucket (List Objects)',
    method: 'GET',
    url: '/?max-keys=2&prefix=J',
    headers: {
      host: 'examplebucket.s3.amazonaws.com',
      'x-amz-date': '20130524T000000Z',
      'x-amz-content-sha256': EMPTY,
    },
    signedHeaders: ['host', 'x-amz-content-sha256', 'x-amz-date'],
    canonical: [
      'GET',
      '/',
      'max-keys=2&prefix=J',
      'host:examplebucket.s3.amazonaws.com',
      `x-amz-content-sha256:${EMPTY}`,
      'x-amz-date:20130524T000000Z',
      '',
      'host;x-amz-content-sha256;x-amz-date',
      EMPTY,
    ].join('\n'),
    toSign: [
      'AWS4-HMAC-SHA256',
      '20130524T000000Z',
      '20130524/us-east-1/s3/aws4_request',
      'df57d21db20da04d7fa30298dd4488ba3a2b47ca3a489c74750e0f1e7df1b9b7',
    ].join('\n'),
    signature: '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
  },
];

describe("the S3 stand-in's SigV4 verifier", () => {
  for (const example of examples) {
    it(`matches AWS's example: ${example.name}`, () => {
      const input = { ...base, ...example };
      expect(canonicalRequest(input)).toBe(example.canonical);
      expect(stringToSign(input)).toBe(example.toSign);
      expect(signature(input)).toBe(example.signature);
      const authorization = `AWS4-HMAC-SHA256 Credential=${KEY_ID}/20130524/us-east-1/s3/aws4_request,SignedHeaders=${[...example.signedHeaders].sort().join(';')},Signature=${example.signature}`;
      const credentials = { accessKeyId: KEY_ID, secretAccessKey: SECRET, region: 'us-east-1' };
      const request = {
        method: example.method,
        url: example.url,
        headers: { ...example.headers, authorization },
      };
      expect(verifySigV4(request, credentials)).toBeNull();
      // One changed header, or another secret, and it no longer holds.
      expect(
        verifySigV4(
          { ...request, headers: { ...request.headers, 'x-amz-date': '20130524T000001Z' } },
          credentials,
        ),
      ).toBe('SignatureDoesNotMatch');
      expect(verifySigV4(request, { ...credentials, secretAccessKey: `${SECRET}x` })).toBe(
        'SignatureDoesNotMatch',
      );
    });
  }

  it('refuses an unsigned payload, and a signature that leaves out what it must cover', () => {
    const credentials = { accessKeyId: KEY_ID, secretAccessKey: SECRET, region: 'us-east-1' };
    const sign = (headers: Record<string, string>, signedHeaders: string[]) => {
      const sig = signature({ ...base, method: 'GET', url: '/k', headers, signedHeaders });
      return {
        method: 'GET',
        url: '/k',
        headers: {
          ...headers,
          authorization: `AWS4-HMAC-SHA256 Credential=${KEY_ID}/20130524/us-east-1/s3/aws4_request, SignedHeaders=${signedHeaders.join(';')}, Signature=${sig}`,
        },
      };
    };
    const headers = {
      host: 'h',
      'x-amz-date': '20130524T000000Z',
      'x-amz-content-sha256': EMPTY,
    };
    const all = ['host', 'x-amz-content-sha256', 'x-amz-date'];
    expect(verifySigV4(sign(headers, all), credentials)).toBeNull();
    expect(
      verifySigV4(
        sign({ ...headers, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' }, all),
        credentials,
      ),
    ).toBe('InvalidRequest');
    for (const left of all) {
      expect(
        verifySigV4(
          sign(
            headers,
            all.filter((name) => name !== left),
          ),
          credentials,
        ),
        left,
      ).toBe('AccessDenied');
    }
    // A scope dated another day than the request.
    const stale = sign(headers, all);
    stale.headers.authorization = stale.headers.authorization.replace('/20130524/', '/20130523/');
    expect(verifySigV4(stale, credentials)).toBe('AuthorizationHeaderMalformed');
  });
});
