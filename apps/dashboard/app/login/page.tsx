'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';

function LoginForm() {
  const params = useSearchParams();
  const denied = params.get('denied') === '1';
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [msg, setMsg] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('sending');
    const { error } = await supabaseBrowser().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback`, shouldCreateUser: true },
    });
    if (error) {
      setState('error');
      setMsg(error.message);
    } else setState('sent');
  }

  return (
    <div className="center panel">
      <h1>Operator sign in</h1>
      {denied && <p className="error">This account is not on the operator allowlist.</p>}
      {state === 'sent' ? (
        <p>Check your inbox for a sign-in link.</p>
      ) : (
        <form onSubmit={submit} className="row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <label className="field">
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@brainchain.example" />
          </label>
          <button className="btn primary" disabled={state === 'sending'}>
            {state === 'sending' ? 'Sending…' : 'Send magic link'}
          </button>
          {state === 'error' && <p className="error small">{msg}</p>}
        </form>
      )}
      <p className="muted small">Only allowlisted operators can use the dashboard.</p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
