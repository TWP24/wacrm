// ============================================================
// Meta Embedded Signup ("Connect WhatsApp Business app") — pure
// helpers shared by the settings button and the server route. No I/O.
//
// Flow (docs/whatsapp-coexistence.md):
//   1. The browser loads Meta's JS SDK and calls FB.login with the
//      Facebook Login for Business configuration id. Embedded Signup v5
//      offers "use my WhatsApp Business app number" (coexistence) by
//      default.
//   2. The popup posts a `WA_EMBEDDED_SIGNUP` session-info message to
//      the opener (ids of the number and WhatsApp Business Account) and
//      FB.login's callback receives a short-lived `code`.
//   3. The browser posts both to /api/whatsapp/embedded-signup, which
//      exchanges the code for a business token, subscribes the account
//      to this app, saves the config and, for a coexistence number,
//      asks Meta for the app's contacts and chat history.
// ============================================================

/** Graph version the JS SDK is initialised with (override: META_SDK_VERSION). */
export const DEFAULT_META_SDK_VERSION = 'v27.0'

/** Embedded Signup version requested from Meta. v5 = coexistence on by default. */
export const EMBEDDED_SIGNUP_VERSION = 'v5'

export interface EmbeddedSignupPublicConfig {
  appId: string
  configId: string
  sdkVersion: string
}

/**
 * The non-secret values the browser needs, or null when the deployment
 * hasn't set Embedded Signup up. The app secret is checked too: without
 * it the server can't exchange the code, so offering the button would
 * only fail at the last step.
 */
export function embeddedSignupPublicConfig(
  env: Record<string, string | undefined>
): EmbeddedSignupPublicConfig | null {
  const appId = env.META_APP_ID?.trim()
  const configId = env.META_EMBEDDED_SIGNUP_CONFIG_ID?.trim()
  const secret = firstAppSecret(env.META_APP_SECRET)
  if (!appId || !configId || !secret) return null
  return {
    appId,
    configId,
    sdkVersion: env.META_SDK_VERSION?.trim() || DEFAULT_META_SDK_VERSION,
  }
}

/**
 * The secret of META_APP_ID's app. META_APP_SECRET may list several
 * secrets for webhook verification (docs/multi-waba.md); the first one
 * must belong to META_APP_ID.
 */
export function firstAppSecret(raw: string | undefined): string | null {
  const first = raw?.split(',').map((s) => s.trim()).find((s) => s.length > 0)
  return first ?? null
}

/** Only Meta's own pages may post session info to us. */
export function isFacebookOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin)
    return (
      protocol === 'https:' &&
      (hostname === 'facebook.com' || hostname.endsWith('.facebook.com'))
    )
  } catch {
    return false
  }
}

export type EmbeddedSignupSessionInfo =
  | {
      kind: 'finish'
      /** True when the business connected its WhatsApp Business app number. */
      coexistence: boolean
      phoneNumberId: string | null
      wabaId: string | null
    }
  | { kind: 'cancel'; currentStep: string | null }
  | { kind: 'error'; message: string; code: string | null; sessionId: string | null }

const NUMERIC_ID = /^\d+$/

function numericId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return typeof value === 'string' && NUMERIC_ID.test(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'number') return String(value)
  return typeof value === 'string' && value ? value : null
}

/**
 * Read a `WA_EMBEDDED_SIGNUP` message posted by Meta's popup. Accepts
 * the session-info shapes of v4 (`data.waba_id`) and v5
 * (`data.messaging_account_ids[]`, `data.is_on_biz_app`). Returns null
 * for anything else the popup posts (the SDK chats on the same channel).
 */
export function parseEmbeddedSignupMessage(
  raw: unknown
): EmbeddedSignupSessionInfo | null {
  let msg: unknown = raw
  if (typeof raw === 'string') {
    try {
      msg = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!msg || typeof msg !== 'object') return null
  const { type, event, data } = msg as {
    type?: unknown
    event?: unknown
    data?: Record<string, unknown>
  }
  if (type !== 'WA_EMBEDDED_SIGNUP' || typeof event !== 'string') return null
  const d = data && typeof data === 'object' ? data : {}

  if (event === 'CANCEL') {
    return { kind: 'cancel', currentStep: stringOrNull(d.current_step) }
  }
  if (event === 'ERROR') {
    return {
      kind: 'error',
      message: stringOrNull(d.error_message) ?? 'Meta reported an error during signup.',
      code: stringOrNull(d.error_code ?? d.error_id),
      sessionId: stringOrNull(d.session_id),
    }
  }
  if (event.startsWith('FINISH')) {
    const accounts = Array.isArray(d.messaging_account_ids) ? d.messaging_account_ids : []
    return {
      kind: 'finish',
      coexistence:
        event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' || d.is_on_biz_app === true,
      phoneNumberId: numericId(d.phone_number_id),
      wabaId: numericId(d.waba_id) ?? numericId(accounts[0]),
    }
  }
  return null
}

/**
 * Which of the account's numbers was just connected. Prefer the id the
 * popup reported (if it really lives under the account); otherwise the
 * account's only number. Null when it can't be told apart.
 */
export function pickSignupPhoneNumber(
  numbers: { id: string }[],
  reported: string | null
): string | null {
  if (reported && numbers.some((n) => n.id === reported)) return reported
  if (!reported && numbers.length === 1) return numbers[0].id
  return null
}

/**
 * WhatsApp Business Account ids a business token was granted, read off
 * Graph's /debug_token `granular_scopes`. Used when the popup's session
 * info never arrived.
 */
export function wabaIdsFromGranularScopes(
  scopes: { scope?: string; target_ids?: string[] }[] | undefined
): string[] {
  const ids = new Set<string>()
  for (const s of scopes ?? []) {
    if (
      s.scope === 'whatsapp_business_management' ||
      s.scope === 'whatsapp_business_messaging'
    ) {
      for (const id of s.target_ids ?? []) if (NUMERIC_ID.test(id)) ids.add(id)
    }
  }
  return [...ids]
}
