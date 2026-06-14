import { getSDK } from '../sdk.ts';
import { useEscapeKey } from '../hooks/useEscapeKey.ts';

interface PendingRequest {
  peerId: string;
  username?: string;
  introducedBy: string;
}

interface Props {
  requests: PendingRequest[];
  onAccept: (peerId: string, username?: string) => void;
  onDecline: (peerId: string) => void;
  onClose: () => void;
}

export default function PendingRequests({ requests, onAccept, onDecline, onClose }: Props) {
  useEscapeKey(onClose);
  async function accept(req: PendingRequest) {
    const sdk = getSDK();
    if (!sdk) return;
    const query = req.username ? `@${req.username}` : req.peerId;
    console.log('[accept] calling addContactByKeyInstance with query:', query, 'peerId:', req.peerId);
    const result = await sdk.addContactByKeyInstance(query);
    console.log('[accept] addContactByKeyInstance returned:', result);
    onAccept(req.peerId, req.username);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6">
      <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-slate-900 border border-slate-700 rounded-t-2xl sm:rounded-2xl w-full sm:max-w-sm">
        <div className="flex items-center justify-between p-5 border-b border-slate-800">
          <h2 className="text-white font-semibold">Contact requests</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="divide-y divide-slate-800">
          {requests.map((req) => (
            <div key={req.peerId} className="flex items-center gap-3 p-4">
              <div className="w-10 h-10 rounded-full bg-slate-700 flex-shrink-0 flex items-center justify-center text-white font-semibold">
                {(req.username ?? req.peerId)[0]?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-white text-sm font-medium truncate">
                  {req.username ? `@${req.username}` : req.peerId.slice(0, 12) + '…'}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => onDecline(req.peerId)}
                  className="w-8 h-8 rounded-full bg-slate-800 hover:bg-slate-700 flex items-center justify-center text-slate-400 hover:text-white transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
                <button
                  onClick={() => accept(req)}
                  className="w-8 h-8 rounded-full bg-brand-600 hover:bg-brand-500 flex items-center justify-center text-white transition-colors"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
