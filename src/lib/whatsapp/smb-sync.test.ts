import { describe, it, expect, vi } from 'vitest'
import { requestCoexistenceSync, smbSyncComplete } from './smb-sync'

const now = () => new Date('2026-11-14T12:00:00.000Z')

describe('requestCoexistenceSync', () => {
  it('asks for contacts first, then history, and stamps both', async () => {
    const request = vi.fn().mockResolvedValue(undefined)

    const state = await requestCoexistenceSync({
      phoneNumberId: 'pn',
      accessToken: 'tok',
      previous: null,
      request,
      now,
    })

    expect(request.mock.calls.map((c) => c[0].syncType)).toEqual(['smb_app_state_sync', 'history'])
    expect(state).toEqual({
      smb_contacts_sync_requested_at: '2026-11-14T12:00:00.000Z',
      smb_history_sync_requested_at: '2026-11-14T12:00:00.000Z',
      smb_sync_error: null,
    })
  })

  it('never re-sends a request Meta already accepted (each is allowed once)', async () => {
    const request = vi.fn().mockResolvedValue(undefined)

    const state = await requestCoexistenceSync({
      phoneNumberId: 'pn',
      accessToken: 'tok',
      previous: { smb_contacts_sync_requested_at: '2026-11-14T10:00:00.000Z' },
      request,
      now,
    })

    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0].syncType).toBe('history')
    expect(state.smb_contacts_sync_requested_at).toBe('2026-11-14T10:00:00.000Z')
  })

  it('still asks for history when contacts fail, and records why', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('window closed'))
      .mockResolvedValueOnce(undefined)

    const state = await requestCoexistenceSync({
      phoneNumberId: 'pn',
      accessToken: 'tok',
      previous: null,
      request,
      now,
    })

    expect(request).toHaveBeenCalledTimes(2)
    expect(state.smb_contacts_sync_requested_at).toBeNull()
    expect(state.smb_history_sync_requested_at).not.toBeNull()
    expect(state.smb_sync_error).toBe('Contacts: window closed')
    errorSpy.mockRestore()
  })
})

describe('smbSyncComplete', () => {
  it('is true only when both were requested', () => {
    expect(smbSyncComplete({ smb_contacts_sync_requested_at: 'x', smb_history_sync_requested_at: 'y' })).toBe(true)
    expect(smbSyncComplete({ smb_contacts_sync_requested_at: 'x' })).toBe(false)
    expect(smbSyncComplete(null)).toBe(false)
  })
})
