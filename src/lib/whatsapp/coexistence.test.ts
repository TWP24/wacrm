import { describe, it, expect } from 'vitest'
import {
  customerIdentityPayload,
  historyMessageStatus,
  isCoexistenceWebhookField,
  isSentByBusiness,
  metaTimestampToIso,
  stateSyncContactName,
  storedContentType,
} from './coexistence'

describe('isCoexistenceWebhookField', () => {
  it('matches the three coexistence fields only', () => {
    expect(isCoexistenceWebhookField('smb_message_echoes')).toBe(true)
    expect(isCoexistenceWebhookField('history')).toBe(true)
    expect(isCoexistenceWebhookField('smb_app_state_sync')).toBe(true)
    expect(isCoexistenceWebhookField('messages')).toBe(false)
  })
})

describe('storedContentType', () => {
  it('keeps allowed types and maps the rest onto the CHECK constraint', () => {
    expect(storedContentType('document')).toBe('document')
    expect(storedContentType('sticker')).toBe('image')
    expect(storedContentType('button')).toBe('interactive')
    expect(storedContentType('reaction')).toBe('text')
    expect(storedContentType('unsupported')).toBe('text')
  })
})

describe('customerIdentityPayload', () => {
  it('treats a phone number as the sender phone', () => {
    expect(customerIdentityPayload('15551230000')).toEqual({
      from: '15551230000',
      from_user_id: undefined,
    })
  })

  it('treats a BSUID handle as a user id, never as a phone', () => {
    expect(customerIdentityPayload('US.13491208655302741918')).toEqual({
      from_user_id: 'US.13491208655302741918',
    })
  })
})

describe('isSentByBusiness', () => {
  it('is true whenever `to` is present', () => {
    expect(isSentByBusiness({ from: '1', to: '2' }, undefined)).toBe(true)
  })

  it('compares `from` with the business number, ignoring formatting', () => {
    expect(isSentByBusiness({ from: '35315550100' }, '+353 1 555 0100')).toBe(true)
    expect(isSentByBusiness({ from: '15551230000' }, '+353 1 555 0100')).toBe(false)
  })

  it('is false when either number is missing', () => {
    expect(isSentByBusiness({ from: '' }, '')).toBe(false)
  })
})

describe('historyMessageStatus', () => {
  it('maps Meta history statuses onto stored ones', () => {
    expect(historyMessageStatus('READ', true)).toBe('read')
    expect(historyMessageStatus('PLAYED', false)).toBe('read')
    expect(historyMessageStatus('DELIVERED', true)).toBe('delivered')
    expect(historyMessageStatus('ERROR', true)).toBe('failed')
  })

  it('defaults by direction, like live messages', () => {
    expect(historyMessageStatus(undefined, true)).toBe('sent')
    expect(historyMessageStatus('PENDING', false)).toBe('delivered')
  })
})

describe('metaTimestampToIso', () => {
  it('converts unix seconds', () => {
    expect(metaTimestampToIso('1700000000')).toBe('2023-11-14T22:13:20.000Z')
  })

  it('falls back to now for junk', () => {
    expect(Number.isNaN(Date.parse(metaTimestampToIso('nope')))).toBe(false)
  })
})

describe('stateSyncContactName', () => {
  it('prefers full name, then first name, then the phone', () => {
    expect(stateSyncContactName({ full_name: ' Ann Lee ', first_name: 'Ann' }, '1')).toBe('Ann Lee')
    expect(stateSyncContactName({ first_name: 'Ann' }, '1')).toBe('Ann')
    expect(stateSyncContactName(undefined, '1')).toBe('1')
  })
})
