import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { requestCoexistenceSync, smbSyncComplete } from '@/lib/whatsapp/smb-sync'

/**
 * POST /api/whatsapp/embedded-signup/sync
 *
 * Retry asking Meta for a coexistence number's WhatsApp Business app
 * contacts and chat history. Only the request(s) not yet accepted are
 * sent — Meta allows each once, within 24 hours of onboarding.
 */
export async function POST() {
  try {
    const { supabase, accountId } = await requireRole('admin')

    const { data: config, error } = await supabase
      .from('whatsapp_config')
      .select(
        'phone_number_id, access_token, coexistence, smb_contacts_sync_requested_at, smb_history_sync_requested_at'
      )
      .eq('account_id', accountId)
      .maybeSingle()
    if (error) {
      console.error('[whatsapp/embedded-signup/sync] config read failed:', error)
      return NextResponse.json({ error: 'Failed to load configuration' }, { status: 500 })
    }
    if (!config?.coexistence) {
      return NextResponse.json(
        { error: 'This number was not connected from the WhatsApp Business app.' },
        { status: 400 }
      )
    }
    if (smbSyncComplete(config)) {
      return NextResponse.json({ success: true, contacts: true, history: true, error: null })
    }

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch {
      return NextResponse.json(
        { error: 'The stored access token cannot be decrypted. Connect again.' },
        { status: 500 }
      )
    }

    const sync = await requestCoexistenceSync({
      phoneNumberId: config.phone_number_id,
      accessToken,
      previous: config,
    })

    const { error: writeError } = await supabase
      .from('whatsapp_config')
      .update({ ...sync, updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
    if (writeError) {
      console.error('[whatsapp/embedded-signup/sync] save failed:', writeError)
      return NextResponse.json({ error: 'Failed to save sync state' }, { status: 500 })
    }

    return NextResponse.json({
      success: !sync.smb_sync_error,
      contacts: !!sync.smb_contacts_sync_requested_at,
      history: !!sync.smb_history_sync_requested_at,
      error: sync.smb_sync_error,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
