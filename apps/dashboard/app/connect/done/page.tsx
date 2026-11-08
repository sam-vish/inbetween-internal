const MESSAGES: Record<string, string> = {
  config: 'Connection is not configured on our side yet. Please tell your Inbetween contact.',
  denied: 'You cancelled the Google permission screen. Nothing was connected.',
  expired: 'This link expired. Ask your Inbetween contact for a fresh one.',
  client: 'We could not find your account. Ask your Inbetween contact for a fresh link.',
  exchange: 'Google did not complete the connection. Please try the link again.',
  no_refresh: 'Google did not grant offline access. Please try again and accept all permissions.',
  no_channel: 'That Google account has no YouTube channel. Sign in with the account that owns your channel.',
  mismatch: 'You signed in with a different YouTube channel than the one we have on file.',
};

export default async function ConnectDone({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const p = await searchParams;
  const ok = p.ok === '1';
  return (
    <div className="center panel">
      <h1>{ok ? 'Channel connected ✅' : 'Connection failed'}</h1>
      {ok ? (
        <p>
          Thanks! <b>{p.channel}</b> is connected with read-only access. We will start clipping automatically the next time you go live. You
          can revoke access at any time from your Google account settings.
        </p>
      ) : (
        <p>
          {MESSAGES[p.error ?? ''] ?? 'Something went wrong.'}
          {p.got ? ` (signed in as “${p.got}”)` : ''}
        </p>
      )}
    </div>
  );
}
