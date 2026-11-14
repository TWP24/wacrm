import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  exchangeEmbeddedSignupCode,
  getPhoneNumberPlatform,
  getTokenGranularScopes,
  listWabaPhoneNumbers,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import {
  explainMetaError,
  metaErrorPayload,
  type MetaConnectStep,
  type MetaErrorContext,
} from '@/lib/whatsapp/meta-error-explain'
import { isNumericMetaId } from '@/lib/whatsapp/waba-pairing'
import {
  embeddedSignupPublicConfig,
  firstAppSecret,
  pickSignupPhoneNumber,
  wabaIdsFromGranularScopes,
} from '@/lib/whatsapp/embedded-signup'
import { requestCoexistenceSync } from '@/lib/whatsapp/smb-sync'
import { encrypt } from '@/lib/whatsapp/encryption'

// Service role, only to see whether ANOTHER account already holds this
// number (RLS hides other accounts' rows). Same reason as the config route.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

function metaFailure(err: unknown, step: MetaConnectStep, ctx: MetaErrorContext) {
  const explained = explainMetaError(err, step, ctx)
  console.error(`[whatsapp/embedded-signup] Meta ${step} failed:`, explained.metaMessage, {
    code: explained.code,
    subcode: explained.subcode,
    fbtrace_id: explained.fbtraceId,
  })
  return NextResponse.json(
    { error: explained.summary, meta: metaErrorPayload(explained) },
    { status: explained.httpStatus }
  )
}

const NOT_CONFIGURED =
  'The Connect button is not set up on this server. Set META_APP_ID, META_APP_SECRET and META_EMBEDDED_SIGNUP_CONFIG_ID (see docs/whatsapp-coexistence.md).'

/**
 * GET /api/whatsapp/embedded-signup
 *
 * The non-secret values the settings page needs to launch Meta's
 * Embedded Signup popup, or `{ enabled: false }` when this deployment
 * hasn't set it up. Read at runtime so no rebuild is needed.
 */
export async function GET() {
  try {
    await requireRole('admin')
    const config = embeddedSignupPublicConfig(process.env)
    return NextResponse.json(config ? { enabled: true, ...config } : { enabled: false })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/whatsapp/embedded-signup
 * Body: { code, waba_id?, phone_number_id?, coexistence? }
 *
 * Finishes the signup: exchanges the code (it expires in ~30 seconds),
 * finds the number, subscribes the WhatsApp Business Account to this
 * app and saves the connection. A coexistence number is already
 * registered by Meta's flow, so /register is never called; instead
 * wacrm asks Meta for the app's contacts and chat history.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const config = embeddedSignupPublicConfig(process.env)
    const appSecret = firstAppSecret(process.env.META_APP_SECRET)
    if (!config || !appSecret) {
      return NextResponse.json({ error: NOT_CONFIGURED }, { status: 503 })
    }

    const body = (await request.json().catch(() => null)) as {
      code?: unknown
      waba_id?: unknown
      phone_number_id?: unknown
      coexistence?: unknown
    } | null
    const code = typeof body?.code === 'string' ? body.code.trim() : ''
    if (!code) {
      return NextResponse.json({ error: 'Missing signup code.' }, { status: 400 })
    }
    const reportedWaba =
      typeof body?.waba_id === 'string' && isNumericMetaId(body.waba_id) ? body.waba_id : null
    const reportedPhone =
      typeof body?.phone_number_id === 'string' && isNumericMetaId(body.phone_number_id)
        ? body.phone_number_id
        : null

    // 1. Code → business token. First, because the code expires fast.
    let accessToken: string
    try {
      accessToken = await exchangeEmbeddedSignupCode({
        code,
        appId: config.appId,
        appSecret,
      })
    } catch (err) {
      return metaFailure(err, 'exchange_code', {})
    }

    // 2. Which WhatsApp Business Account. The popup normally says; if
    //    its message never arrived, read the token's grants instead.
    let wabaId = reportedWaba
    if (!wabaId) {
      try {
        const granted = wabaIdsFromGranularScopes(
          await getTokenGranularScopes({
            inputToken: accessToken,
            appId: config.appId,
            appSecret,
          })
        )
        wabaId = granted.length === 1 ? granted[0] : null
      } catch (err) {
        return metaFailure(err, 'exchange_code', {})
      }
    }
    if (!wabaId) {
      return NextResponse.json(
        {
          error:
            'Meta did not say which WhatsApp Business Account was connected. Run Connect again and pick a single account.',
        },
        { status: 400 }
      )
    }
    const metaCtx: MetaErrorContext = { wabaId, phoneNumberId: reportedPhone }

    // 3. Which number.
    let phoneNumberId: string | null
    try {
      const numbers = await listWabaPhoneNumbers({ wabaId, accessToken })
      phoneNumberId = pickSignupPhoneNumber(numbers, reportedPhone)
    } catch (err) {
      return metaFailure(err, 'waba_phone_numbers', metaCtx)
    }
    if (!phoneNumberId) {
      return NextResponse.json(
        {
          error:
            'Could not tell which phone number was connected. Run Connect again, or enter the Phone Number ID in the form below.',
        },
        { status: 400 }
      )
    }
    metaCtx.phoneNumberId = phoneNumberId

    // One number per account across this instance (issue #136).
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phoneNumberId)
      .neq('account_id', accountId)
      .maybeSingle()
    if (claimedError) {
      console.error('[whatsapp/embedded-signup] ownership check failed:', claimedError)
      return NextResponse.json({ error: 'Failed to validate configuration' }, { status: 500 })
    }
    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance.',
        },
        { status: 409 }
      )
    }

    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({ phoneNumberId, accessToken })
    } catch (err) {
      return metaFailure(err, 'verify_number', metaCtx)
    }

    // 4. Coexistence? The popup says so; Meta's own flag is the backstop.
    let coexistence = body?.coexistence === true
    if (!coexistence) {
      try {
        const platform = await getPhoneNumberPlatform({ phoneNumberId, accessToken })
        coexistence = platform.isOnBizApp === true
      } catch (err) {
        console.warn(
          '[whatsapp/embedded-signup] could not read is_on_biz_app:',
          err instanceof Error ? err.message : err
        )
      }
    }

    // 5. Webhooks for this account go to this app.
    try {
      await subscribeWabaToApp({ wabaId, accessToken })
    } catch (err) {
      return metaFailure(err, 'subscribe_waba', metaCtx)
    }

    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select(
        'id, phone_number_id, registered_at, smb_contacts_sync_requested_at, smb_history_sync_requested_at'
      )
      .eq('account_id', accountId)
      .maybeSingle()
    const sameNumber = existing?.phone_number_id === phoneNumberId

    let encryptedAccessToken: string
    try {
      encryptedAccessToken = encrypt(accessToken)
    } catch (err) {
      console.error(
        '[whatsapp/embedded-signup] encryption failed:',
        err instanceof Error ? err.message : err
      )
      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 }
      )
    }

    // 6. Ask for the app's contacts and history. Once each, so a
    //    reconnect of the same number keeps what was already requested.
    const sync = coexistence
      ? await requestCoexistenceSync({
          phoneNumberId,
          accessToken,
          previous: sameNumber ? existing : null,
        })
      : {
          smb_contacts_sync_requested_at: null,
          smb_history_sync_requested_at: null,
          smb_sync_error: null,
        }

    const now = new Date().toISOString()
    const row = {
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
      access_token: encryptedAccessToken,
      status: 'connected',
      connected_at: now,
      // A coexistence number is registered by Meta's flow. Any other
      // number keeps the existing state: the form's PIN path registers it.
      registered_at: coexistence ? now : sameNumber ? existing?.registered_at ?? null : null,
      subscribed_apps_at: now,
      last_registration_error: null,
      coexistence,
      onboarded_via: 'embedded_signup',
      ...sync,
      updated_at: now,
    }

    // The user's own client, so the admin-only RLS policies apply.
    const { error: writeError } = existing
      ? await supabase.from('whatsapp_config').update(row).eq('account_id', accountId)
      : await supabase
          .from('whatsapp_config')
          .insert({ account_id: accountId, user_id: userId, verify_token: null, ...row })
    if (writeError) {
      console.error('[whatsapp/embedded-signup] save failed:', writeError)
      return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      coexistence,
      phone_info: phoneInfo,
      sync: coexistence
        ? {
            contacts: !!sync.smb_contacts_sync_requested_at,
            history: !!sync.smb_history_sync_requested_at,
            error: sync.smb_sync_error,
          }
        : null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
