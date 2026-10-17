import { OWNED_PROFILE_SWITCH } from '@tsuuanmi/system-provider-core'
import { describe, expect, it } from 'vitest'
import { profileUser } from '../src/profiles.ts'

describe('profileUser: who runs Chrome on a login profile, read from /proc/<pid>/cmdline (ADR-0030)', () => {
  const dir = '/home/op/.dsh/system/login-profiles/gemini-main'
  const chrome = '/opt/chrome/chrome'

  it('reads the single space-separated line Chrome rewrites its command line into, browser and children alike', () => {
    expect(profileUser(`${chrome} --disable-gpu --user-data-dir=${dir} ${OWNED_PROFILE_SWITCH} --remote-debugging-pipe about:blank\0`, [dir])).toEqual({ browser: true, owned: true })
    expect(profileUser(`${chrome} --type=renderer --user-data-dir=${dir} --lang=en-US\0`, [dir])).toEqual({ browser: false, owned: false })
    // A child carries no switch of the browser's, so it is never owned on its own.
    expect(profileUser(`${chrome} --type=zygote --user-data-dir=${dir} ${OWNED_PROFILE_SWITCH}\0`, [dir])).toEqual({ browser: false, owned: false })
  })

  it('reads a NUL-separated command line, and a browser without the switch is not owned', () => {
    expect(profileUser([chrome, `--user-data-dir=${dir}`, OWNED_PROFILE_SWITCH, 'https://example.test/'].join('\0') + '\0', [dir])).toEqual({ browser: true, owned: true })
    expect(profileUser([chrome, `--user-data-dir=${dir}`, '--no-first-run'].join('\0') + '\0', [dir])).toEqual({ browser: true, owned: false })
  })

  it('matches the profile at the end of the line, and a path with spaces', () => {
    expect(profileUser(`${chrome} ${OWNED_PROFILE_SWITCH} --user-data-dir=${dir}`, [dir])).toEqual({ browser: true, owned: true })
    const spaced = '/home/op/My Profiles/gemini main'
    expect(profileUser(`${chrome} --user-data-dir=${spaced} ${OWNED_PROFILE_SWITCH}\0`, [spaced])).toEqual({ browser: true, owned: true })
    expect(profileUser([chrome, `--user-data-dir=${spaced}`].join('\0'), [spaced])).toEqual({ browser: true, owned: false })
  })

  it('never takes another profile for this one: a sibling, a parent, or the switch as part of another argument', () => {
    expect(profileUser(`${chrome} --user-data-dir=${dir}2 ${OWNED_PROFILE_SWITCH}\0`, [dir])).toBeUndefined()
    expect(profileUser(`${chrome} --user-data-dir=${dir}/Default\0`, [dir])).toBeUndefined()
    expect(profileUser(`${chrome} --user-data-dir=/home/op/.dsh/system/login-profiles\0`, [dir])).toBeUndefined()
    expect(profileUser(`${chrome} --user-data-dir=${dir} ${OWNED_PROFILE_SWITCH}-not\0`, [dir])).toEqual({ browser: true, owned: false })
    expect(profileUser(`node -e x -- --user-data-dir=${dir}x\0`, [dir])).toBeUndefined()
  })
})
