import { describe, it, expect } from 'vitest'
import {
  DEFAULT_META_SDK_VERSION,
  embeddedSignupPublicConfig,
  firstAppSecret,
  isFacebookOrigin,
  parseEmbeddedSignupMessage,
  pickSignupPhoneNumber,
  wabaIdsFromGranularScopes,
} from './embedded-signup'

describe('embeddedSignupPublicConfig', () => {
  const env = {
    META_APP_ID: '123',
    META_APP_SECRET: 's1,s2',
    META_EMBEDDED_SIGNUP_CONFIG_ID: '456',
  }

  it('returns the browser-safe values when everything is set', () => {
    expect(embeddedSignupPublicConfig(env)).toEqual({
      appId: '123',
      configId: '456',
      sdkVersion: DEFAULT_META_SDK_VERSION,
    })
  })

  it('never exposes the app secret', () => {
    expect(JSON.stringify(embeddedSignupPublicConfig(env))).not.toContain('s1')
  })

  it('honours META_SDK_VERSION', () => {
    expect(embeddedSignupPublicConfig({ ...env, META_SDK_VERSION: 'v28.0' })?.sdkVersion).toBe('v28.0')
  })

  it('is null when any of the three is missing', () => {
    expect(embeddedSignupPublicConfig({ ...env, META_APP_ID: '' })).toBeNull()
    expect(embeddedSignupPublicConfig({ ...env, META_EMBEDDED_SIGNUP_CONFIG_ID: undefined })).toBeNull()
    expect(embeddedSignupPublicConfig({ ...env, META_APP_SECRET: ' , ' })).toBeNull()
  })
})

describe('firstAppSecret', () => {
  it('takes the first non-empty entry', () => {
    expect(firstAppSecret(' , a , b')).toBe('a')
    expect(firstAppSecret(undefined)).toBeNull()
  })
})

describe('isFacebookOrigin', () => {
  it('accepts facebook.com and its subdomains over https', () => {
    expect(isFacebookOrigin('https://www.facebook.com')).toBe(true)
    expect(isFacebookOrigin('https://business.facebook.com')).toBe(true)
    expect(isFacebookOrigin('https://facebook.com')).toBe(true)
  })

  it('rejects look-alikes, http and junk', () => {
    expect(isFacebookOrigin('https://evilfacebook.com')).toBe(false)
    expect(isFacebookOrigin('https://facebook.com.evil.test')).toBe(false)
    expect(isFacebookOrigin('http://www.facebook.com')).toBe(false)
    expect(isFacebookOrigin('null')).toBe(false)
  })
})

describe('parseEmbeddedSignupMessage', () => {
  it('reads a v5 coexistence finish', () => {
    const msg = JSON.stringify({
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
      data: { phone_number_id: '111', messaging_account_ids: ['222'], is_on_biz_app: true, business_id: '9' },
    })
    expect(parseEmbeddedSignupMessage(msg)).toEqual({
      kind: 'finish',
      coexistence: true,
      phoneNumberId: '111',
      wabaId: '222',
    })
  })

  it('reads a v4 finish with waba_id and no phone', () => {
    expect(
      parseEmbeddedSignupMessage({
        type: 'WA_EMBEDDED_SIGNUP',
        event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
        data: { waba_id: '222' },
      })
    ).toEqual({ kind: 'finish', coexistence: true, phoneNumberId: null, wabaId: '222' })
  })

  it('a plain FINISH is a new number, not coexistence', () => {
    const info = parseEmbeddedSignupMessage({
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'FINISH',
      data: { phone_number_id: '111', waba_id: '222' },
    })
    expect(info).toMatchObject({ kind: 'finish', coexistence: false })
  })

  it('drops non-numeric ids rather than passing them on', () => {
    const info = parseEmbeddedSignupMessage({
      type: 'WA_EMBEDDED_SIGNUP',
      event: 'FINISH',
      data: { phone_number_id: '../me', waba_id: 'abc' },
    })
    expect(info).toMatchObject({ phoneNumberId: null, wabaId: null })
  })

  it('reads cancel and error', () => {
    expect(
      parseEmbeddedSignupMessage({ type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: { current_step: 'PHONE_NUMBER_SETUP' } })
    ).toEqual({ kind: 'cancel', currentStep: 'PHONE_NUMBER_SETUP' })
    expect(
      parseEmbeddedSignupMessage({
        type: 'WA_EMBEDDED_SIGNUP',
        event: 'ERROR',
        data: { error_message: 'Nope', error_code: 524126, session_id: 'abc' },
      })
    ).toEqual({ kind: 'error', message: 'Nope', code: '524126', sessionId: 'abc' })
  })

  it('ignores other SDK chatter', () => {
    expect(parseEmbeddedSignupMessage('not json')).toBeNull()
    expect(parseEmbeddedSignupMessage({ type: 'OTHER', event: 'FINISH' })).toBeNull()
    expect(parseEmbeddedSignupMessage(null)).toBeNull()
  })
})

describe('pickSignupPhoneNumber', () => {
  const numbers = [{ id: '1' }, { id: '2' }]

  it('uses the reported number when it belongs to the account', () => {
    expect(pickSignupPhoneNumber(numbers, '2')).toBe('2')
  })

  it('refuses a reported number the account does not hold', () => {
    expect(pickSignupPhoneNumber(numbers, '3')).toBeNull()
  })

  it("falls back to the account's only number", () => {
    expect(pickSignupPhoneNumber([{ id: '7' }], null)).toBe('7')
    expect(pickSignupPhoneNumber(numbers, null)).toBeNull()
  })
})

describe('wabaIdsFromGranularScopes', () => {
  it('collects WhatsApp account ids from both WhatsApp scopes, deduplicated', () => {
    expect(
      wabaIdsFromGranularScopes([
        { scope: 'whatsapp_business_management', target_ids: ['10', '11'] },
        { scope: 'whatsapp_business_messaging', target_ids: ['10'] },
        { scope: 'business_management', target_ids: ['99'] },
      ])
    ).toEqual(['10', '11'])
  })
})
