// @vitest-environment node
/**
 * 邀请链接：盒子认 `unrealbox://join?…`（落地页 [用虚幻盒子打开]）和网页上直接复制的
 * `https://host/join?p=…#ca=sha256:…`；指纹只取 64 位十六进制，别的都不认。
 */
import { describe, expect, it } from 'vitest'
import { areaToProjectPath, parseTeamJoinLink, parseTeamOpenLink } from './teamProject'

const CA = 'ba3d4ae23e2cd60cada98a6be8bd4bdbc076084818148ccc43b79e347a031acb'

describe('parseTeamJoinLink', () => {
  it('reads the web invite link', () => {
    expect(parseTeamJoinLink(`http://127.0.0.1:47484/join?p=xinghai#ca=sha256:${CA}`)).toEqual({
      server: 'http://127.0.0.1:47484',
      project: 'xinghai',
      caFingerprint: CA
    })
  })

  it('reads the unrealbox:// link from the landing page', () => {
    const link = `unrealbox://join?server=${encodeURIComponent('https://nas.local:8084/')}&p=xinghai&ca=sha256:${CA.toUpperCase()}`
    expect(parseTeamJoinLink(link)).toEqual({
      server: 'https://nas.local:8084',
      project: 'xinghai',
      caFingerprint: CA
    })
  })

  it('refuses anything else', () => {
    expect(parseTeamJoinLink('')).toBeNull()
    expect(parseTeamJoinLink('not a link')).toBeNull()
    expect(parseTeamJoinLink('https://nas.local/p/xinghai')).toBeNull()
    expect(parseTeamJoinLink('unrealbox://open?server=https://h')).toBeNull()
    expect(parseTeamJoinLink('unrealbox://join?server=file:///c:/x')).toBeNull()
    expect(parseTeamJoinLink('ftp://h/join?p=x')).toBeNull()
  })

  it('drops a malformed fingerprint instead of trusting it', () => {
    expect(parseTeamJoinLink('https://h/join?p=x#ca=sha256:abc')?.caFingerprint).toBeNull()
  })
})

describe('parseTeamOpenLink', () => {
  it('opens a page of a project from UE (submit number, inbox, sync folders)', () => {
    const server = encodeURIComponent('http://127.0.0.1:47484')
    expect(
      parseTeamOpenLink(`unrealbox://open?server=${server}&path=/p/xinghai/submits/1532`)
    ).toEqual({
      server: 'http://127.0.0.1:47484',
      project: 'xinghai',
      path: '/p/xinghai/submits/1532'
    })
    expect(
      parseTeamOpenLink(
        `unrealbox://open?server=${server}&path=${encodeURIComponent('/p/xinghai/compare?from=1460&to=latest')}`
      )?.path
    ).toBe('/p/xinghai/compare?from=1460&to=latest')
  })

  it('refuses paths outside a project and other schemes', () => {
    expect(parseTeamOpenLink('unrealbox://open?server=http://h&path=/admin')).toBeNull()
    expect(parseTeamOpenLink('https://h/p/xinghai')).toBeNull()
    expect(parseTeamOpenLink('unrealbox://join?server=http://h&p=x')).toBeNull()
  })
})

describe('areaToProjectPath', () => {
  it('drops the reference / delivery N layer of an outsourcing area', () => {
    expect(areaToProjectPath('reference/Content/Env/M_Rock.uasset')).toBe(
      'Content/Env/M_Rock.uasset'
    )
    expect(areaToProjectPath('delivery/7/Content/Env/Rocks/SM_Rock_11.uasset')).toBe(
      'Content/Env/Rocks/SM_Rock_11.uasset'
    )
    expect(areaToProjectPath('Content/Env/M_Rock.uasset')).toBe('Content/Env/M_Rock.uasset')
    expect(areaToProjectPath('delivery/x/Content/a.uasset')).toBe('delivery/x/Content/a.uasset')
    expect(areaToProjectPath('reference/moodboard/a.png')).toBe('reference/moodboard/a.png')
  })
})
