import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  existing: null as Record<string, unknown> | null,
  claimed: null as Record<string, unknown> | null,
  inserts: [] as Record<string, unknown>[],
  updates: [] as Record<string, unknown>[],
  meta: {
    exchangeEmbeddedSignupCode: vi.fn(),
    getTokenGranularScopes: vi.fn(),
    listWabaPhoneNumbers: vi.fn(),
    verifyPhoneNumber: vi.fn(),
    getPhoneNumberPlatform: vi.fn(),
    subscribeWabaToApp: vi.fn(),
    requestSmbAppDataSync: vi.fn(),
    registerPhoneNumber: vi.fn(),
  },
}))

vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
}))

const userClient = {
  from: () => ({
    select: () => ({
      eq: () => ({ maybeSingle: () => Promise.resolve({ data: h.existing, error: null }) }),
    }),
    update: (row: Record<string, unknown>) => {
      h.updates.push(row)
      return { eq: () => Promise.resolve({ error: null }) }
    },
    insert: (row: Record<string, unknown>) => {
      h.inserts.push(row)
      return Promise.resolve({ error: null })
    },
  }),
}

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ supabase: userClient, accountId: 'acc-1', userId: 'user-1' })),
  toErrorResponse: (err: unknown) => ({ body: { error: String(err) }, status: 500 }),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          neq: () => ({ maybeSingle: () => Promise.resolve({ data: h.claimed, error: null }) }),
        }),
      }),
    }),
  }),
}))

vi.mock('@/lib/whatsapp/meta-api', () => h.meta)
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (v: string) => `enc:${v}` }))

import { POST } from './route'

type Res = { body: Record<string, unknown>; status: number }

function post(body: Record<string, unknown>): Promise<Res> {
  return POST({ json: async () => body } as unknown as Request) as unknown as Promise<Res>
}

const COEX_BODY = { code: 'the-code', waba_id: '222', phone_number_id: '111', coexistence: true }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('META_APP_ID', 'app-1')
  vi.stubEnv('META_APP_SECRET', 'secret-1,other')
  vi.stubEnv('META_EMBEDDED_SIGNUP_CONFIG_ID', 'cfg-1')
  h.existing = null
  h.claimed = null
  h.inserts = []
  h.updates = []
  h.meta.exchangeEmbeddedSignupCode.mockResolvedValue('business-token')
  h.meta.getTokenGranularScopes.mockResolvedValue([])
  h.meta.listWabaPhoneNumbers.mockResolvedValue([{ id: '111', display_phone_number: '+353 1 555 0100' }])
  h.meta.verifyPhoneNumber.mockResolvedValue({ verified_name: 'Cuanco' })
  h.meta.getPhoneNumberPlatform.mockResolvedValue({ isOnBizApp: true, platformType: 'CLOUD_API' })
  h.meta.subscribeWabaToApp.mockResolvedValue(undefined)
  h.meta.requestSmbAppDataSync.mockResolvedValue(undefined)
})

describe('POST /api/whatsapp/embedded-signup', () => {
  it('connects a WhatsApp Business app number without ever calling /register', async () => {
    const res = await post(COEX_BODY)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      success: true,
      coexistence: true,
      sync: { contacts: true, history: true, error: null },
    })
    // The code is exchanged with the FIRST secret — META_APP_ID's.
    expect(h.meta.exchangeEmbeddedSignupCode).toHaveBeenCalledWith({
      code: 'the-code',
      appId: 'app-1',
      appSecret: 'secret-1',
    })
    expect(h.meta.subscribeWabaToApp).toHaveBeenCalledWith({ wabaId: '222', accessToken: 'business-token' })
    expect(h.meta.registerPhoneNumber).not.toHaveBeenCalled()
    expect(h.meta.requestSmbAppDataSync.mock.calls.map((c) => c[0].syncType)).toEqual([
      'smb_app_state_sync',
      'history',
    ])

    expect(h.inserts).toHaveLength(1)
    const row = h.inserts[0]
    expect(row).toMatchObject({
      account_id: 'acc-1',
      user_id: 'user-1',
      phone_number_id: '111',
      waba_id: '222',
      access_token: 'enc:business-token',
      status: 'connected',
      coexistence: true,
      onboarded_via: 'embedded_signup',
      smb_sync_error: null,
    })
    expect(row.registered_at).toEqual(expect.any(String))
    expect(row.smb_contacts_sync_requested_at).toEqual(expect.any(String))
    expect(row.smb_history_sync_requested_at).toEqual(expect.any(String))
  })

  it('is refused before any Meta call when the server is not set up', async () => {
    vi.stubEnv('META_EMBEDDED_SIGNUP_CONFIG_ID', '')

    const res = await post(COEX_BODY)

    expect(res.status).toBe(503)
    expect(h.meta.exchangeEmbeddedSignupCode).not.toHaveBeenCalled()
  })

  it('finds the account from the token when the popup never said', async () => {
    h.meta.getTokenGranularScopes.mockResolvedValue([
      { scope: 'whatsapp_business_management', target_ids: ['333'] },
    ])

    const res = await post({ code: 'the-code' })

    expect(res.status).toBe(200)
    expect(h.meta.listWabaPhoneNumbers).toHaveBeenCalledWith({ wabaId: '333', accessToken: 'business-token' })
    // Coexistence comes from Meta's own is_on_biz_app flag here.
    expect(h.inserts[0]).toMatchObject({ waba_id: '333', phone_number_id: '111', coexistence: true })
  })

  it('refuses a reported number the account does not hold', async () => {
    const res = await post({ ...COEX_BODY, phone_number_id: '999' })

    expect(res.status).toBe(400)
    expect(h.meta.subscribeWabaToApp).not.toHaveBeenCalled()
    expect(h.inserts).toHaveLength(0)
  })

  it('refuses a number another account already holds', async () => {
    h.claimed = { account_id: 'acc-2' }

    const res = await post(COEX_BODY)

    expect(res.status).toBe(409)
    expect(h.meta.subscribeWabaToApp).not.toHaveBeenCalled()
    expect(h.inserts).toHaveLength(0)
  })

  it('a new (non-app) number is saved unregistered and asks for no app data', async () => {
    h.meta.getPhoneNumberPlatform.mockResolvedValue({ isOnBizApp: false, platformType: 'CLOUD_API' })

    const res = await post({ ...COEX_BODY, coexistence: false })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ coexistence: false, sync: null })
    expect(h.meta.requestSmbAppDataSync).not.toHaveBeenCalled()
    expect(h.inserts[0]).toMatchObject({ coexistence: false, registered_at: null })
  })

  it('a failed code exchange saves nothing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.meta.exchangeEmbeddedSignupCode.mockRejectedValue(
      Object.assign(new Error('Invalid verification code format.'), { code: 100, httpStatus: 400 })
    )

    const res = await post(COEX_BODY)

    expect(res.status).toBe(400)
    expect(res.body.meta).toMatchObject({ step: 'exchange_code', code: 100 })
    expect(h.inserts).toHaveLength(0)
    expect(h.updates).toHaveLength(0)
    errorSpy.mockRestore()
  })

  it('reconnecting the same number never re-requests what Meta already accepted', async () => {
    h.existing = {
      id: 'cfg',
      phone_number_id: '111',
      registered_at: '2026-11-14T09:00:00.000Z',
      smb_contacts_sync_requested_at: '2026-11-14T09:00:00.000Z',
      smb_history_sync_requested_at: null,
    }

    await post(COEX_BODY)

    expect(h.meta.requestSmbAppDataSync).toHaveBeenCalledTimes(1)
    expect(h.meta.requestSmbAppDataSync.mock.calls[0][0].syncType).toBe('history')
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0]).toMatchObject({
      smb_contacts_sync_requested_at: '2026-11-14T09:00:00.000Z',
    })
    // The update never touches the per-account verify token.
    expect(h.updates[0]).not.toHaveProperty('verify_token')
  })
})
