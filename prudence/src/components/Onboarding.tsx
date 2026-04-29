import { useState } from 'react';

interface Props {
  onComplete: (username: string, password: string) => Promise<void>;
}

export default function Onboarding({ onComplete }: Props) {
  const [mode, setMode] = useState<'create' | 'login'>('create');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const usernameValid = /^[a-z0-9_-]{3,30}$/.test(username);
  const passwordValid = password.length >= 8;
  const confirmValid = password === confirm;
  const canSubmit = mode === 'login'
    ? usernameValid && passwordValid
    : usernameValid && passwordValid && confirmValid;

  function switchMode(next: 'create' | 'login') {
    setMode(next);
    setError('');
    setConfirm('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || loading) return;
    setError('');
    setLoading(true);
    try {
      await onComplete(username, password);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
      setLoading(false);
    }
  }

  return (
    <div className="h-full bg-slate-950 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-10">
          <img src="/logo-stacked.png" alt="Prudence" className="h-24 mx-auto mb-4 object-contain" />
          <p className="text-slate-400 text-sm">
            {mode === 'create' ? 'Create your account to get started.' : 'Sign in to your account.'}
          </p>
        </div>

        {/* Mode tabs */}
        <div className="flex rounded-xl bg-slate-900 p-1 mb-5">
          <button
            type="button"
            onClick={() => switchMode('create')}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'create' ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-white'}`}
          >
            Create account
          </button>
          <button
            type="button"
            onClick={() => switchMode('login')}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'login' ? 'bg-brand-600 text-white' : 'text-slate-400 hover:text-white'}`}
          >
            Sign in
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
              placeholder="Username"
              maxLength={30}
              autoComplete="username"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 transition-colors text-sm font-mono"
            />
            {mode === 'create' && (
              <p className="mt-1.5 text-xs text-slate-500">
                3–30 characters, letters/numbers/_ and - only.
                {username.length > 0 && !usernameValid && (
                  <span className="text-red-400 ml-2">Too short</span>
                )}
              </p>
            )}
          </div>

          <div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
              className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 transition-colors text-sm"
            />
            {mode === 'create' && (
              <p className="mt-1.5 text-xs text-slate-500">
                At least 8 characters.
                {password.length > 0 && !passwordValid && (
                  <span className="text-red-400 ml-2">Too short</span>
                )}
              </p>
            )}
          </div>

          {mode === 'create' && (
            <div>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Confirm password"
                autoComplete="new-password"
                className={`w-full bg-slate-900 border rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none transition-colors text-sm ${
                  confirm && !confirmValid ? 'border-red-500 focus:border-red-400' : 'border-slate-700 focus:border-brand-500'
                }`}
              />
              {confirm && !confirmValid && (
                <p className="mt-1.5 text-xs text-red-400">Passwords don't match</p>
              )}
            </div>
          )}

          {error && <p className="text-red-400 text-sm text-center">{error}</p>}

          <button
            type="submit"
            disabled={!canSubmit || loading}
            className="w-full bg-brand-500 hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium py-3 rounded-xl transition-colors text-sm"
          >
            {loading ? 'Setting up…' : mode === 'create' ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-slate-600">
          Your keys are derived from your password.<br />
          No email, no phone number, no recovery option.
        </p>
      </div>
    </div>
  );
}
