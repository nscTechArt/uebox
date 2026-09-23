/**
 * 签名手写的，就拿 AWS 文档里公开的样例逐字对。
 * 对不上的话所有厂商（OSS、COS、R2、MinIO 都认同一套 SigV4）一起报 SignatureDoesNotMatch。
 */

import { describe, expect, it } from 'vitest'

import { objectUrl, parseListObjects, presignGetUrl, signRequest, type S3Target } from './s3Client'

const AWS_EXAMPLE: S3Target = {
  endpoint: 'https://s3.amazonaws.com',
  region: 'us-east-1',
  bucket: 'examplebucket',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  forcePathStyle: false
}

describe('SigV4', () => {
  it('请求头签名与 AWS 文档「GET Object」样例一致', () => {
    const url = objectUrl(AWS_EXAMPLE, 'test.txt')
    const headers = signRequest(
      AWS_EXAMPLE,
      'GET',
      url,
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      { range: 'bytes=0-9' },
      new Date('2013-05-24T00:00:00Z')
    )

    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
    )
  })

  it('预签名链接与 AWS 文档样例一致', () => {
    const url = presignGetUrl(AWS_EXAMPLE, 'test.txt', new Date('2013-05-24T00:00:00Z'), 86400)

    expect(url).toContain('https://examplebucket.s3.amazonaws.com/test.txt?')
    expect(url).toMatch(
      /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/
    )
  })

  it('同一个签名时刻签出来的链接逐字相同 —— 对话里每轮重发，字节一变缓存就断', () => {
    const at = new Date('2026-09-20T00:00:00Z')
    expect(presignGetUrl(AWS_EXAMPLE, 'a/b.mp4', at)).toBe(
      presignGetUrl(AWS_EXAMPLE, 'a/b.mp4', at)
    )
  })
})

describe('寻址', () => {
  it('虚拟主机式把桶名放进域名', () => {
    expect(objectUrl(AWS_EXAMPLE, 'uebox-media/x y.mp4').toString()).toBe(
      'https://examplebucket.s3.amazonaws.com/uebox-media/x%20y.mp4'
    )
  })

  it('路径式把桶名放进路径（MinIO、R2）', () => {
    const target = { ...AWS_EXAMPLE, endpoint: 'http://127.0.0.1:9000', forcePathStyle: true }
    expect(objectUrl(target, 'k.mp4').toString()).toBe('http://127.0.0.1:9000/examplebucket/k.mp4')
  })
})

describe('parseListObjects', () => {
  it('取出键、大小、时间和翻页令牌', () => {
    const xml = `<?xml version="1.0"?><ListBucketResult>
      <IsTruncated>true</IsTruncated>
      <Contents><Key>uebox-media/a&amp;b.mp4</Key><LastModified>2026-09-20T01:02:03.000Z</LastModified><Size>1024</Size></Contents>
      <Contents><Key>uebox-media/c.mp3</Key><LastModified>2026-09-21T01:02:03.000Z</LastModified><Size>2048</Size></Contents>
      <NextContinuationToken>tok==</NextContinuationToken>
    </ListBucketResult>`

    expect(parseListObjects(xml)).toEqual({
      objects: [
        { key: 'uebox-media/a&b.mp4', size: 1024, lastModified: '2026-09-20T01:02:03.000Z' },
        { key: 'uebox-media/c.mp3', size: 2048, lastModified: '2026-09-21T01:02:03.000Z' }
      ],
      nextToken: 'tok=='
    })
  })

  it('没翻页就没有令牌', () => {
    expect(
      parseListObjects('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')
    ).toEqual({
      objects: []
    })
  })
})
