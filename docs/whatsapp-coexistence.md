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

## Setup with the Connect button (recommended)

Settings → WhatsApp shows a **Connect WhatsApp Business app** button once
the server is set up for Meta's Embedded Signup. The person connecting
clicks it, logs in to Facebook, picks their business, enters the number,
scans the QR code the WhatsApp Business app shows on the phone, and
chooses whether to share chat history. wacrm then does the rest:

1. Exchanges the signup code for a business token (server-side; the code
   expires in about 30 seconds).
2. Finds the WhatsApp Business Account and number from the popup's
   session info, or from the token's grants if that message never arrived.
3. Subscribes the account to your Meta app (`POST /{waba_id}/subscribed_apps`).
4. Saves the connection. A coexistence number is marked registered and
   `/register` is never called on it.
5. Asks Meta for the app's contacts, then chat history
   (`POST /{phone_number_id}/smb_app_data`). Each request is allowed once,
   within 24 hours. If one fails, the settings card shows why and has an
   **Ask Meta again** button that only resends what wasn't accepted.

The button uses Embedded Signup **v5**, which offers "use my WhatsApp
Business app number" by default. A brand-new number also works. It is
saved unregistered, and the form's PIN path registers it, as before.

### One-time Meta setup

1. **Business Verification** for your business portfolio, and your Meta
   app onboarded as a **Tech Provider** (App Dashboard → WhatsApp). Meta
   only offers Embedded Signup to Tech Providers and Solution Partners.
   App admins and developers can test the flow with their own Facebook
   login before the app is fully approved.
2. **WhatsApp → Configuration → Webhook**: callback
   `https://<your-wacrm>/api/whatsapp/webhook`, verify token =
   `META_WEBHOOK_VERIFY_TOKEN` (below). Subscribe to `messages`,
   `account_update`, `smb_message_echoes`, `history` and
   `smb_app_state_sync` (plus `message_template_*` if you use templates).
3. **Facebook Login for Business → Settings**: turn on Client OAuth login,
   Web OAuth login, Enforce HTTPS, Embedded Browser OAuth Login, Strict
   Mode and Login with the JavaScript SDK. Add your wacrm domain (HTTPS)
   to Allowed Domains and Valid OAuth Redirect URIs.
4. **Facebook Login for Business → Configurations → Create from
   template → "WhatsApp Embedded Signup Configuration"**. Copy the
   configuration id.

### Server environment

| Variable | Value |
| --- | --- |
| `META_APP_ID` | Your Meta app id |
| `META_APP_SECRET` | Your Meta app secret. If you list several, **the first one must be `META_APP_ID`'s**: it is used to exchange the signup code. |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | The configuration id from step 4 |
| `META_WEBHOOK_VERIFY_TOKEN` | Any long random string (`openssl rand -hex 32`), pasted into the Meta webhook settings too. Accounts connected with the button store no per-account verify token. |
| `META_SDK_VERSION` | Optional. Graph version for the JS SDK, default `v27.0`. |

Apply migration `043_whatsapp_embedded_signup.sql`. With any of the first
three variables missing, the button stays hidden and the manual form
works as before.

## Manual setup (without the button)

If the number was onboarded for coexistence elsewhere, enter its Phone
Number ID, WhatsApp Business Account ID and access token in the form.
**Leave the two-step PIN empty.** wacrm skips `/register` when no PIN is
given, and never calls it for a number connected with the button. If you
connect manually, the app that onboarded the number has to make the
contacts and history requests, and those webhooks go to that app.

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
