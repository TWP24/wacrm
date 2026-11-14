// ============================================================
// Ask Meta for a coexistence number's WhatsApp Business app data —
// contacts first, then chat history (POST /{phone_number_id}/smb_app_data).
//
// Each request may be made ONCE, within 24 hours of onboarding, by the
// app that onboarded the number. A type already requested is skipped,
// so the retry button can't burn a second attempt. The data itself
// arrives later on the `smb_app_state_sync` / `history` webhooks.
// ============================================================

import {
  requestSmbAppDataSync,
  type RequestSmbAppDataSyncArgs,
  type SmbAppDataSyncType,
} from './meta-api'

/** Columns on whatsapp_config that record the requests (migration 043). */
export interface SmbSyncState {
  smb_contacts_sync_requested_at: string | null
  smb_history_sync_requested_at: string | null
  smb_sync_error: string | null
}

const LABEL: Record<SmbAppDataSyncType, string> = {
  smb_app_state_sync: 'Contacts',
  history: 'Chat history',
}

/** True when Meta has been asked for both contacts and chat history. */
export function smbSyncComplete(state: Partial<SmbSyncState> | null | undefined): boolean {
  return !!state?.smb_contacts_sync_requested_at && !!state?.smb_history_sync_requested_at
}

export async function requestCoexistenceSync(args: {
  phoneNumberId: string
  accessToken: string
  previous: Partial<SmbSyncState> | null
  /** Injected in tests. */
  request?: (a: RequestSmbAppDataSyncArgs) => Promise<void>
  now?: () => Date
}): Promise<SmbSyncState> {
  const request = args.request ?? requestSmbAppDataSync
  const now = args.now ?? (() => new Date())
  const state: SmbSyncState = {
    smb_contacts_sync_requested_at: args.previous?.smb_contacts_sync_requested_at ?? null,
    smb_history_sync_requested_at: args.previous?.smb_history_sync_requested_at ?? null,
    smb_sync_error: null,
  }
  const errors: string[] = []

  const steps: [SmbAppDataSyncType, keyof SmbSyncState][] = [
    ['smb_app_state_sync', 'smb_contacts_sync_requested_at'],
    ['history', 'smb_history_sync_requested_at'],
  ]
  for (const [syncType, column] of steps) {
    if (state[column]) continue
    try {
      await request({
        phoneNumberId: args.phoneNumberId,
        accessToken: args.accessToken,
        syncType,
      })
      state[column] = now().toISOString()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[smb-sync] ${syncType} request failed:`, message)
      errors.push(`${LABEL[syncType]}: ${message}`)
    }
  }

  state.smb_sync_error = errors.length ? errors.join(' · ') : null
  return state
}
