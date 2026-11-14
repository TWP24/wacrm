'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, MessageCircle, RotateCcw, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  EMBEDDED_SIGNUP_VERSION,
  isFacebookOrigin,
  parseEmbeddedSignupMessage,
  type EmbeddedSignupPublicConfig,
  type EmbeddedSignupSessionInfo,
} from '@/lib/whatsapp/embedded-signup';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';

// The slice of Meta's JS SDK this component uses.
type FbLoginResponse = { authResponse?: { code?: string } | null; status?: string };
type FbSdk = {
  init: (opts: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }) => void;
  login: (cb: (response: FbLoginResponse) => void, opts: Record<string, unknown>) => void;
};
declare global {
  interface Window {
    FB?: FbSdk;
    fbAsyncInit?: () => void;
  }
}

const SDK_SRC = 'https://connect.facebook.net/en_US/sdk.js';
/** How long to wait for the popup's session info after the code arrives. */
const SESSION_INFO_GRACE_MS = 4000;

let sdkPromise: Promise<FbSdk> | null = null;

/** Load and initialise Meta's SDK once per page. */
function loadFacebookSdk(appId: string, version: string): Promise<FbSdk> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<FbSdk>((resolve, reject) => {
    const ready = () => {
      if (!window.FB) return reject(new Error('Meta SDK did not load'));
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: true, version });
      resolve(window.FB);
    };
    if (window.FB) return ready();
    window.fbAsyncInit = ready;
    const script = document.createElement('script');
    script.src = SDK_SRC;
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error('Meta SDK did not load'));
    };
    document.body.appendChild(script);
  });
  return sdkPromise;
}

type SyncResult = { contacts: boolean; history: boolean; error: string | null };

/**
 * "Connect WhatsApp Business app": Meta Embedded Signup. Hidden unless
 * the server has META_APP_ID, META_APP_SECRET and
 * META_EMBEDDED_SIGNUP_CONFIG_ID set. Admin-only, like the rest of
 * the WhatsApp settings writes.
 */
export function WhatsAppEmbeddedSignup({
  config,
  onConnected,
}: {
  config: WhatsAppConfigType | null;
  onConnected: () => void | Promise<void>;
}) {
  const t = useTranslations('Settings.whatsapp');
  const [publicConfig, setPublicConfig] = useState<EmbeddedSignupPublicConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);

  // The code (FB.login callback) and the session info (postMessage)
  // arrive separately and in either order.
  const codeRef = useRef<string | null>(null);
  const sessionRef = useRef<Extract<EmbeddedSignupSessionInfo, { kind: 'finish' }> | null>(null);
  const submittedRef = useRef(false);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/whatsapp/embedded-signup')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.enabled) {
          setPublicConfig({ appId: data.appId, configId: data.configId, sdkVersion: data.sdkVersion });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const finish = useCallback(() => {
    if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
    graceTimerRef.current = null;
    setBusy(false);
  }, []);

  const submit = useCallback(async () => {
    const code = codeRef.current;
    if (!code || submittedRef.current) return;
    submittedRef.current = true;
    if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
    const session = sessionRef.current;
    try {
      const res = await fetch('/api/whatsapp/embedded-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          waba_id: session?.wabaId ?? undefined,
          phone_number_id: session?.phoneNumberId ?? undefined,
          coexistence: session?.coexistence ?? undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        toast.error(t('connectFailed', { message: data.error ?? `HTTP ${res.status}` }));
        return;
      }
      if (data.coexistence) {
        setLastSync(data.sync);
        toast.success(t('connectSuccessCoex'));
      } else {
        toast.success(t('connectSuccess'));
      }
      await onConnected();
    } catch (err) {
      toast.error(t('connectFailed', { message: (err as Error).message }));
    } finally {
      finish();
    }
  }, [finish, onConnected, t]);

  // Session info from Meta's popup.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isFacebookOrigin(event.origin)) return;
      const info = parseEmbeddedSignupMessage(event.data);
      if (!info) return;
      if (info.kind === 'finish') {
        sessionRef.current = info;
        if (codeRef.current) void submit();
      } else if (info.kind === 'cancel') {
        if (!codeRef.current) {
          toast.message(t('connectCancelled'));
          finish();
        }
      } else {
        toast.error(t('connectFailed', { message: info.message }));
        if (!codeRef.current) finish();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [finish, submit, t]);

  useEffect(
    () => () => {
      if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
    },
    []
  );

  const connect = async () => {
    if (!publicConfig) return;
    setBusy(true);
    codeRef.current = null;
    sessionRef.current = null;
    submittedRef.current = false;
    let FB: FbSdk;
    try {
      FB = await loadFacebookSdk(publicConfig.appId, publicConfig.sdkVersion);
    } catch {
      toast.error(t('sdkLoadFailed'));
      setBusy(false);
      return;
    }
    // FB.login's callback must not be async (the SDK rejects it).
    FB.login(
      (response) => {
        const code = response.authResponse?.code;
        if (!code) {
          // Closed without finishing; the CANCEL message (if any) says why.
          finish();
          return;
        }
        codeRef.current = code;
        if (sessionRef.current) {
          void submit();
        } else {
          // The code expires in ~30s: give the session info a moment,
          // then let the server work the ids out from the token.
          graceTimerRef.current = setTimeout(() => void submit(), SESSION_INFO_GRACE_MS);
        }
      },
      {
        config_id: publicConfig.configId,
        response_type: 'code',
        override_default_response_type: true,
        // v5 offers "use my WhatsApp Business app number" by default.
        extras: { version: EMBEDDED_SIGNUP_VERSION },
      }
    );
  };

  const retrySync = async () => {
    setRetrying(true);
    try {
      const res = await fetch('/api/whatsapp/embedded-signup/sync', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(t('connectFailed', { message: data.error ?? `HTTP ${res.status}` }));
        return;
      }
      setLastSync({ contacts: data.contacts, history: data.history, error: data.error });
      if (data.error) toast.error(t('syncError', { error: data.error }));
      else toast.success(t('syncRequestedToast'));
      await onConnected();
    } catch (err) {
      toast.error(t('connectFailed', { message: (err as Error).message }));
    } finally {
      setRetrying(false);
    }
  };

  if (!publicConfig) return null;

  const sync: SyncResult | null = config?.coexistence
    ? {
        contacts: !!config.smb_contacts_sync_requested_at,
        history: !!config.smb_history_sync_requested_at,
        error: config.smb_sync_error ?? lastSync?.error ?? null,
      }
    : lastSync;

  const syncLine = (label: string, done: boolean) => (
    <li className="flex items-center gap-2">
      {done ? (
        <CheckCircle2 className="size-3.5 text-emerald-400" />
      ) : (
        <XCircle className="size-3.5 text-amber-400" />
      )}
      <span>
        {label}: {done ? t('syncRequested') : t('syncPending')}
      </span>
    </li>
  );

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <MessageCircle className="size-4 text-primary" />
          {t('connectTitle')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">{t('connectDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button onClick={connect} disabled={busy}>
          {busy ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {t('connecting')}
            </>
          ) : (
            t('connectButton')
          )}
        </Button>

        {config?.coexistence && (
          <p className="text-xs text-emerald-300">{t('coexBadge')}</p>
        )}

        {sync && (
          <div className="rounded-md border border-border p-3 text-xs text-muted-foreground space-y-2">
            <ul className="space-y-1">
              {syncLine(t('syncContacts'), sync.contacts)}
              {syncLine(t('syncHistory'), sync.history)}
            </ul>
            {sync.error && <p className="text-red-300 break-words">{t('syncError', { error: sync.error })}</p>}
            {(!sync.contacts || !sync.history) && (
              <>
                <p>{t('syncWindowHint')}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={retrySync}
                  disabled={retrying}
                  className="h-7 border-border bg-transparent text-foreground hover:bg-muted"
                >
                  {retrying ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                  {t('syncRetry')}
                </Button>
              </>
            )}
          </div>
        )}

        <p className="text-xs text-muted-foreground">{t('orManual')}</p>
      </CardContent>
    </Card>
  );
}
