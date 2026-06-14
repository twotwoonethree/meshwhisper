import { useEscapeKey } from '../hooks/useEscapeKey.ts';

interface Invite {
  groupId: string;
  groupName: string;
  invitedBy: string;
  members: string[];
}

interface Props {
  invites: Invite[];
  getContactName: (peerId: string) => string | undefined;
  onAccept: (groupId: string) => void;
  onDecline: (groupId: string) => void;
  onClose: () => void;
}

export default function GroupInviteModal({ invites, getContactName, onAccept, onDecline, onClose }: Props) {
  useEscapeKey(onClose);
  if (invites.length === 0) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-sm flex flex-col max-h-[80vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h2 className="text-white font-semibold text-sm">Group invitations</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-800">
          {invites.map((inv) => {
            const inviterName = getContactName(inv.invitedBy) ?? inv.invitedBy.slice(0, 8);
            return (
              <div key={inv.groupId} className="px-5 py-4">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-full bg-brand-700 flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5 text-brand-200" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-white font-medium text-sm">{inv.groupName}</p>
                    <p className="text-slate-400 text-xs">
                      Invited by @{inviterName} · {inv.members.length} members
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => onDecline(inv.groupId)}
                    className="flex-1 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors"
                  >
                    Decline
                  </button>
                  <button
                    onClick={() => onAccept(inv.groupId)}
                    className="flex-1 py-2 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-sm font-medium transition-colors"
                  >
                    Join
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
