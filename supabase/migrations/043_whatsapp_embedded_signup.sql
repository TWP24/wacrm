-- ============================================================
-- 043_whatsapp_embedded_signup
--
-- "Connect WhatsApp Business app": Meta Embedded Signup with the
-- coexistence option, so a number already in the WhatsApp Business app
-- keeps working on the phone AND in wacrm (docs/whatsapp-coexistence.md).
--
--   coexistence                 — the number is also live in the
--                                 WhatsApp Business app. Such a number
--                                 is registered by the onboarding flow;
--                                 wacrm must never call /register on it.
--   onboarded_via               — 'manual' (pasted ids + token, the
--                                 original form) or 'embedded_signup'.
--   smb_contacts_sync_requested_at / smb_history_sync_requested_at
--                               — when wacrm asked Meta to send the
--                                 app's contacts and chat history
--                                 (POST /{phone_number_id}/smb_app_data).
--                                 Each may be requested once, within 24
--                                 hours of onboarding; the timestamps
--                                 stop a second request and drive the
--                                 retry button.
--   smb_sync_error              — why the last sync request failed.
--
-- All writes still go through the admin-only whatsapp_config RLS
-- policies from migration 017. Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS coexistence BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS onboarded_via TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS smb_contacts_sync_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS smb_history_sync_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS smb_sync_error TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_config_onboarded_via_check'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_onboarded_via_check
      CHECK (onboarded_via IN ('manual', 'embedded_signup'));
  END IF;
END $$;
