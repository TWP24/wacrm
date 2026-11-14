# Using your WhatsApp Business app number (coexistence)

Meta lets one phone number run on the **WhatsApp Business app** and the
**Cloud API** at the same time ("coexistence"). You keep chatting from your
phone as usual, and wacrm sees the same conversations.

## What wacrm does with a coexistence number

| Webhook field | What it is | What wacrm does |
| --- | --- | --- |
| `messages` | Customer messages and delivery statuses | Same as any number: inbox, automations, flows, AI, public webhooks |
| `smb_message_echoes` | A message you typed in the phone app or on a linked device | Stored as an **agent** message in the customer's thread. No unread bump and no automations, flows, AI or `message.received`. An active flow run is paused, the same as when you reply from the inbox. Media is copied like inbound media. |
| `history` | Up to about 6 months of past 1:1 chats, sent in chunks after onboarding | Imported quietly into each thread: both sides, original timestamps, no unread bump, no automations, no public webhooks. Media is **not** downloaded during import. It is fetched through `/api/whatsapp/media/<id>` when opened. The inbox preview only moves forward. If you chose not to share history in the app, the webhook logs it and imports nothing. |
| `smb_app_state_sync` | Your phone's address book | Adds a CRM contact for any number wacrm doesn't know. It never renames an existing contact and never deletes one when you remove it on your phone. |

Every write is idempotent on `(conversation_id, message_id)`, so Meta
retries and overlapping history chunks never create duplicates.

Group chats are never synced (a Meta limit).

## Setup

### 1. Meta prerequisites (one time)

- WhatsApp Business app **2.24.17 or newer** on the phone that has the number.
- The number is onboarded through **Embedded Signup with the coexistence
  option** (`featureType: "whatsapp_business_app_onboarding"`). Meta only
  offers this to apps owned by a **Tech Provider or Solution Partner**:
  either your own Meta app (after Business Verification and Tech Provider
  onboarding) or a partner's.
- You have **24 hours** after onboarding to request the contact and history
  sync (`POST /{phone_number_id}/smb_app_data` with
  `sync_type: "smb_app_state_sync"`, then `sync_type: "history"`). Each can
  only be requested once. Only the app that onboarded the number can make
  these requests, and the `history` and `smb_app_state_sync` webhooks go to
  that app.

### 2. In your Meta app

1. **WhatsApp → Configuration → Webhook**: set the callback to
   `https://<your-wacrm>/api/whatsapp/webhook` and subscribe to
   `messages`, `smb_message_echoes`, `history`, `smb_app_state_sync`
   (plus the `message_template_*` fields if you use templates).
2. Make sure the app is subscribed to the WhatsApp Business Account
   (`POST /{waba_id}/subscribed_apps`). wacrm's settings page shows this
   status.

### 3. In wacrm → Settings → WhatsApp

Enter the Phone Number ID, WhatsApp Business Account ID and access token
as usual. **Leave the two-step PIN empty.** A coexistence number is already
registered by the onboarding flow, so wacrm skips `/register` when no PIN is
given. If the settings page shows "Not registered" for this number, that is
expected.

## Limits to know

- Throughput is fixed at **20 messages per second** for a coexistence number.
- Onboarding unlinks your companion devices (WhatsApp Web, desktop). Link
  them again afterwards. Up to four are supported, except WhatsApp for
  Windows and Wear OS.
- In the app, broadcast lists become read-only. Disappearing and view-once
  messages, live location and calls are not mirrored to the API.
- Messages you send from the phone app are free. Messages sent through the
  API (wacrm) are billed at Cloud API rates. The 24-hour customer-service
  window applies only to API messages.
- To stop, disconnect from inside the WhatsApp Business app. The Deregister
  API does not work on a coexistence number.
