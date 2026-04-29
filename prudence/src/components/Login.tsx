import { useState } from 'react';

interface Props {
  username: string;
  onLogin: (password: string) => Promise<void>;
  onSwitchUser: () => void;
}

export default function Login({ username, onLogin, onSwitchUser }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || loading) return;
    setError('');
    setLoading(true);
    try {
      await onLogin(password);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setLoading(false);
    }
  }

  return (
    <div className="h-full bg-slate-950 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-10">
          <img src="/logo-stacked.png" alt="Prudence" className="h-24 mx-auto mb-4 object-contain" />
          <p className="text-slate-400 text-sm">Welcome back, @{username}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete="current-password"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-brand-500 transition-colors text-sm"
          />

          {error && <p className="text-red-400 text-sm text-center">{error}</p>}

          <button
            type="submit"
            disabled={!password || loading}
            className="w-full bg-brand-500 hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium py-3 rounded-xl transition-colors text-sm"
          >
            {loading ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>

        <button
          onClick={onSwitchUser}
          className="mt-6 w-full text-center text-xs text-slate-600 hover:text-slate-400 transition-colors"
        >
          Not @{username}? Switch account
        </button>
      </div>
    </div>
  );
}
