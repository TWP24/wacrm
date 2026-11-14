// ============================================================
// Coexistence — one number on BOTH the WhatsApp Business app and
// the Cloud API. Pure helpers, no I/O; the webhook route owns the
// writes.
//
// Once a Business-app number is onboarded for coexistence, Meta sends
// three extra webhook fields alongside the usual `messages`:
//
//   smb_message_echoes  — a message the business typed in the phone
//                         app (or a linked device). `value.message_echoes[]`,
//                         each shaped like an inbound message plus `to`
//                         (the customer).
//   history             — up to ~6 months of past 1:1 chats, delivered in
//                         chunks after onboarding. `value.history[]` →
//                         `threads[]` (thread `id` = the customer) →
//                         `messages[]`, each with `history_context.status`.
//                         A business that declines history sharing in the
//                         app gets an `errors[]` entry (code 2593109).
//   smb_app_state_sync  — the app's address book. `value.state_sync[]` with
//                         `contact.{full_name, first_name, phone_number}`
//                         and `action` (add / remove).
//
// Group chats are never synced. See docs/whatsapp-coexistence.md.
// ============================================================

import { normalizePhone } from './phone-utils'
import { isBusinessScopedUserId } from './wa-identity'

export const COEXISTENCE_WEBHOOK_FIELDS = [
  'smb_message_echoes',
  'history',
  'smb_app_state_sync',
] as const

export type CoexistenceWebhookField = (typeof COEXISTENCE_WEBHOOK_FIELDS)[number]

export function isCoexistenceWebhookField(
  field: string
): field is CoexistenceWebhookField {
  return (COEXISTENCE_WEBHOOK_FIELDS as readonly string[]).includes(field)
}

/** Meta's error code when the business turned history sharing off in the app. */
export const HISTORY_SHARING_DECLINED = 2593109

/**
 * Map a WhatsApp message type onto the `messages.content_type` CHECK
 * (text, image, document, audio, video, location, template,
 * interactive). Anything else lands on the closest allowed value so
 * the INSERT can't fail on the constraint.
 */
export function storedContentType(type: string): string {
  switch (type) {
    case 'text':
    case 'image':
    case 'document':
    case 'audio':
    case 'video':
    case 'location':
    case 'template':
    case 'interactive':
      return type
    case 'sticker':
      return 'image' // stickers are images
    case 'button':
      return 'interactive' // template quick-reply tap (issue #478)
    default:
      return 'text' // reaction, unknown → text fallback
  }
}

/**
 * The customer side of a thread or echo, as the `{ from, from_user_id }`
 * pair `resolveInboundIdentity` expects. Meta normally uses the phone
 * number, but a username-only customer is identified by a BSUID.
 */
export function customerIdentityPayload(
  handle: string | undefined,
  userId?: string
): { from?: string; from_user_id?: string } {
  const h = handle?.trim() ?? ''
  if (h && isBusinessScopedUserId(h)) return { from_user_id: h }
  return { from: h || undefined, from_user_id: userId }
}

/**
 * Was this history message sent by the business (from the app) rather
 * than the customer? Meta includes `to` only on business-sent entries;
 * otherwise compare `from` with the business's own number.
 */
export function isSentByBusiness(
  message: { from?: string; to?: string },
  businessPhone: string | undefined
): boolean {
  if (message.to) return true
  const from = normalizePhone(message.from ?? '')
  const business = normalizePhone(businessPhone ?? '')
  return !!from && !!business && from === business
}

export type StoredMessageStatus = 'sent' | 'delivered' | 'read' | 'failed'

/**
 * Map `history_context.status` onto the `messages.status` CHECK. Live
 * inbound messages are stored as `delivered`, so customer-sent history
 * defaults to that too; business-sent history defaults to `sent`.
 */
export function historyMessageStatus(
  raw: string | undefined,
  sentByBusiness: boolean
): StoredMessageStatus {
  switch (raw?.toLowerCase()) {
    case 'read':
    case 'played':
      return 'read'
    case 'delivered':
      return 'delivered'
    case 'error':
    case 'failed':
      return 'failed'
    default:
      return sentByBusiness ? 'sent' : 'delivered'
  }
}

/** Unix-seconds string from Meta → ISO timestamp (now if unparseable). */
export function metaTimestampToIso(timestamp: string | undefined): string {
  const seconds = Number.parseInt(timestamp ?? '', 10)
  return Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : new Date().toISOString()
}

/** Display name for a contact synced from the app's address book. */
export function stateSyncContactName(
  contact: { full_name?: string; first_name?: string } | undefined,
  phone: string
): string {
  return contact?.full_name?.trim() || contact?.first_name?.trim() || phone
}
