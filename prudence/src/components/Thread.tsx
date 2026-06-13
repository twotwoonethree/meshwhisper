import { useEffect, useRef, useState } from 'react';
import type { AppMessage, Contact, GroupInfo } from '../types.ts';
import { isImageMime, formatFileSize, fileIconLabel } from '../media.ts';

interface Props {
  contact: Contact;
  group?: GroupInfo;
  /** True if the local user is the group's admin (creator). Enables group-management UI. */
  isGroupAdmin?: boolean;
  /** True if the group has no admin (anyone can add members). */
  isAdminless?: boolean;
  /** The local user's own peerId — used to filter group member lists. */
  localPeerId?: string;
  /** Available contacts that aren't already in the group — passed to the add-members picker. */
  addableContacts?: Contact[];
  messages: AppMessage[];
  isTyping: boolean;
  onBack: () => void;
  onSend: (text: string, replyTo?: { messageId: string; snippetText?: string }) => void;
  onRemove: () => void;
  onAddMember?: (peerId: string) => void;
  /** Transfer admin role to another member, or pass '' to make adminless. */
  onTransferAdmin?: (newAdminId: string) => Promise<void>;
  /** Admin-only: kick a member out of the group. */
  onKickMember?: (peerId: string) => void;
  /** Admin (or any member of an adminless group): rename the group. */
  onRenameGroup?: (newName: string) => Promise<void>;
  /** DM only: toggle the local user's reaction with `emoji` on a message. */
  onReact?: (messageId: string, emoji: string) => Promise<void>;
  /** DM only: forward a message to another contact. */
  onForwardMessage?: (messageId: string, toPeerId: string) => Promise<void>;
  /** DM only: set the conversation's disappearing-messages TTL. */
  onSetDisappearing?: (ttlMs: number | null) => Promise<void>;
  /** DM only: current disappearing-messages TTL (ms), or null = off. */
  disappearingTtlMs?: number | null;
  /** Other contacts available as forward targets (excludes the current convo's peer). */
  forwardTargets?: Contact[];
  onAttach?: (file: File) => void;
  onDownloadMedia?: (msgId: string) => Promise<string | null>;
  /** DM only: ask the peer to replay their view of the conversation back to us. */
  onRestoreHistory?: () => void;
  /** Export the conversation as a downloadable text transcript. */
  onExport?: () => void;
}

function formatTimestamp(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function StatusIcon({ status }: { status: AppMessage['status'] }) {
  if (status === 'sending') return <span className="text-slate-600">○</span>;
  if (status === 'sent') return <span className="text-slate-500">✓</span>;
  if (status === 'delivered') return <span className="text-slate-400">✓✓</span>;
  if (status === 'read') return <span className="text-brand-400">✓✓</span>;
  if (status === 'failed') return <span className="text-red-400">!</span>;
  return null;
}

function FileBadge({ mimeType }: { mimeType: string }) {
  return (
    <span className="text-[9px] font-bold tracking-wide bg-slate-600 text-slate-200 rounded px-1 py-0.5">
      {fileIconLabel(mimeType)}
    </span>
  );
}

function ImageBubble({ msg, isOut, onDownload }: { msg: AppMessage; isOut: boolean; onDownload: () => void }) {
  const { media } = msg;
  if (!media) return null;
  const thumb = media.objectUrl ?? media.thumb;
  const downloading = media.status === 'downloading' || media.status === 'uploading';

  return (
    <div
      className={`relative rounded-2xl overflow-hidden max-w-[220px] cursor-pointer ${isOut ? 'rounded-br-sm' : 'rounded-bl-sm'}`}
      onClick={onDownload}
    >
      {thumb ? (
        <img src={thumb} alt="Photo" className="w-full object-cover block" />
      ) : (
        <div className="w-[160px] h-[120px] bg-slate-700 flex items-center justify-center">
          <svg className="w-8 h-8 text-slate-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z" />
          </svg>
        </div>
      )}
      {downloading && (
        <div className="absolute inset-0 bg-slate-900/60 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {!downloading && media.status === 'pending' && !media.objectUrl && (
        <div className="absolute inset-0 bg-slate-900/40 flex items-center justify-center">
          <svg className="w-7 h-7 text-white drop-shadow" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
        </div>
      )}
    </div>
  );
}

function FileBubble({ msg, isOut, onDownload }: { msg: AppMessage; isOut: boolean; onDownload: () => void }) {
  const { media } = msg;
  if (!media) return null;
  const downloading = media.status === 'downloading';
  const done = media.status === 'ready';

  return (
    <div className={`flex items-center gap-3 px-3.5 py-2.5 rounded-2xl min-w-[200px] max-w-[260px] ${isOut ? 'bg-brand-600 rounded-br-sm' : 'bg-slate-800 rounded-bl-sm'}`}>
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${isOut ? 'bg-brand-700' : 'bg-slate-700'}`}>
        <FileBadge mimeType={media.mimeType} />
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm truncate font-medium ${isOut ? 'text-white' : 'text-slate-100'}`}>
          {media.fileName ?? 'File'}
        </p>
        {media.fileSize !== undefined && (
          <p className={`text-xs ${isOut ? 'text-brand-200' : 'text-slate-400'}`}>
            {formatFileSize(media.fileSize)}
          </p>
        )}
      </div>
      {!isOut && (
        <button
          onClick={onDownload}
          disabled={downloading || done}
          className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-colors ${done ? 'text-slate-500' : 'text-slate-300 hover:text-white'}`}
        >
          {downloading ? (
            <div className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
          ) : done ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
          )}
        </button>
      )}
    </div>
  );
}

const ACCEPT = 'image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip';

export default function Thread({ contact, group, isGroupAdmin, isAdminless, localPeerId, addableContacts, messages, isTyping, onBack, onSend, onRemove, onAddMember, onTransferAdmin, onKickMember, onRenameGroup, onReact, onForwardMessage, onSetDisappearing, disappearingTtlMs, forwardTargets, onAttach, onDownloadMedia, onRestoreHistory, onExport }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [adminChoice, setAdminChoice] = useState<'idle' | 'choose'>('idle');
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [actionsMenuFor, setActionsMenuFor] = useState<string | null>(null);
  const [replyContext, setReplyContext] = useState<{ messageId: string; snippetText?: string } | null>(null);
  const [forwardingMessageId, setForwardingMessageId] = useState<string | null>(null);
  const [showDisappearingPicker, setShowDisappearingPicker] = useState(false);
  // The DM case is identified by the absence of a group on the conversation.
  // Reactions / replies / forwards / disappearing-messages are DM-only in v1
  // (matching the SDK's deferral of group fan-out for these features).
  const isDM = !group;

  // When the local user is the admin AND there are other members, the
  // leave button takes them through the admin-handoff dialog first.
  // For an adminless group OR an admined group with no other members,
  // the regular confirm dialog applies.
  const otherMembers = group?.members.filter((m) => m.peerId !== localPeerId) ?? [];
  const adminMustHandOff =
    !!group && !!isGroupAdmin && !!onTransferAdmin && otherMembers.length > 0;

  function handleLeaveClick() {
    if (adminMustHandOff) setAdminChoice('choose');
    else setConfirmDelete(true);
  }

  async function chooseAdminless() {
    setAdminChoice('idle');
    if (!onTransferAdmin) return;
    try { await onTransferAdmin(''); }
    catch (e) { console.error('[group] transfer to adminless failed:', e); }
    onRemove();
  }

  async function chooseSuccessor(peerId: string) {
    setAdminChoice('idle');
    if (!onTransferAdmin) return;
    try { await onTransferAdmin(peerId); }
    catch (e) { console.error('[group] transfer to', peerId, 'failed:', e); }
    onRemove();
  }
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  }

  function submit() {
    const text = inputRef.current?.value.trim();
    if (!text) return;
    onSend(text, replyContext ?? undefined);
    if (inputRef.current) inputRef.current.value = '';
    autoResize();
    setReplyContext(null);
  }

  function autoResize() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file && onAttach) onAttach(file);
    e.target.value = '';
  }

  async function handleImageTap(msg: AppMessage) {
    if (!onDownloadMedia) return;
    if (msg.media?.objectUrl) { setLightboxUrl(msg.media.objectUrl); return; }
    if (msg.media?.status === 'downloading' || msg.media?.status === 'uploading') return;
    const url = await onDownloadMedia(msg.id);
    if (url) setLightboxUrl(url);
  }

  return (
    <div className="flex flex-col h-full bg-slate-950">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900">
        <button onClick={onBack} className="sm:hidden text-slate-400 hover:text-white transition-colors mr-1">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
          </svg>
        </button>
        {group ? (
          <div className="w-8 h-8 rounded-full bg-brand-700 flex-shrink-0 flex items-center justify-center">
            <svg className="w-4 h-4 text-brand-200" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
            </svg>
          </div>
        ) : (
          <div className="w-8 h-8 rounded-full bg-brand-600 flex-shrink-0 flex items-center justify-center text-white text-sm font-semibold">
            {contact.displayName[0]?.toUpperCase()}
          </div>
        )}
        <div className="flex-1">
          <p className="text-white font-medium text-sm">{contact.displayName}</p>
          {group ? (
            <p className="text-slate-500 text-xs">{group.members.length} members</p>
          ) : contact.username ? (
            <p className="text-slate-500 text-xs">@{contact.username}</p>
          ) : null}
        </div>
        {group && (
          <button
            onClick={() => setShowMembers(true)}
            className="w-8 h-8 rounded-full hover:bg-slate-800 flex items-center justify-center text-slate-500 hover:text-white transition-colors"
            title="Members"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z" />
            </svg>
          </button>
        )}
        {group && (isGroupAdmin || isAdminless) && onAddMember && (
          <button
            onClick={() => setShowAddMember(true)}
            className="w-8 h-8 rounded-full hover:bg-slate-800 flex items-center justify-center text-slate-500 hover:text-white transition-colors"
            title="Add member"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
          </button>
        )}
        {onSetDisappearing && (
          <button
            onClick={() => setShowDisappearingPicker(true)}
            className={`w-8 h-8 rounded-full hover:bg-slate-800 flex items-center justify-center transition-colors ${disappearingTtlMs ? 'text-brand-400' : 'text-slate-500 hover:text-white'}`}
            title={disappearingTtlMs ? `Disappearing messages on (${disappearingTtlMs >= 24 * 60 * 60_000 ? Math.round(disappearingTtlMs / (24 * 60 * 60_000)) + 'd' : Math.round(disappearingTtlMs / (60 * 60_000)) + 'h'})` : 'Disappearing messages'}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
            </svg>
          </button>
        )}
        {!group && onRestoreHistory && (
          <button
            onClick={onRestoreHistory}
            className="w-8 h-8 rounded-full hover:bg-slate-800 flex items-center justify-center text-slate-500 hover:text-white transition-colors"
            title="Restore history from this contact"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
            </svg>
          </button>
        )}
        {onExport && (
          <button
            onClick={onExport}
            className="w-8 h-8 rounded-full hover:bg-slate-800 flex items-center justify-center text-slate-500 hover:text-white transition-colors"
            title="Export conversation as text"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
          </button>
        )}
        <button
          onClick={handleLeaveClick}
          className="w-8 h-8 rounded-full hover:bg-slate-800 flex items-center justify-center text-slate-500 hover:text-red-400 transition-colors"
          title={group ? 'Leave group' : 'Delete conversation'}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
          </svg>
        </button>
      </div>

      {/* Members panel — visible to anyone in the group; admins can kick. */}
      {showMembers && group && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => setShowMembers(false)} />
          <div className="relative bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-sm flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
              <div className="flex-1 min-w-0">
                {editingName && onRenameGroup && (isGroupAdmin || isAdminless) ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const next = draftName.trim();
                      if (!next || next === group.name) {
                        setEditingName(false);
                        setRenameError(null);
                        return;
                      }
                      setRenameBusy(true);
                      setRenameError(null);
                      onRenameGroup(next)
                        .then(() => { setEditingName(false); })
                        .catch((err: unknown) => {
                          setRenameError(err instanceof Error ? err.message : 'Rename failed');
                        })
                        .finally(() => { setRenameBusy(false); });
                    }}
                    className="flex items-center gap-2"
                  >
                    <input
                      autoFocus
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      disabled={renameBusy}
                      maxLength={64}
                      className="flex-1 min-w-0 bg-slate-800 border border-slate-700 rounded-md px-2 py-1 text-white text-sm focus:outline-none focus:border-brand-500"
                    />
                    <button
                      type="submit"
                      disabled={renameBusy || !draftName.trim() || draftName.trim() === group.name}
                      className="text-xs px-2 py-1 rounded-md bg-brand-600 hover:bg-brand-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => { setEditingName(false); setRenameError(null); }}
                      disabled={renameBusy}
                      className="text-xs px-2 py-1 rounded-md text-slate-400 hover:text-white transition-colors"
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <div className="flex items-center gap-2">
                    <h2 className="text-white font-semibold text-sm truncate">{group.name}</h2>
                    {onRenameGroup && (isGroupAdmin || isAdminless) && (
                      <button
                        onClick={() => { setDraftName(group.name); setEditingName(true); setRenameError(null); }}
                        title="Rename group"
                        className="text-slate-500 hover:text-white transition-colors flex-shrink-0"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" />
                        </svg>
                      </button>
                    )}
                  </div>
                )}
                {renameError && <p className="text-red-400 text-xs mt-1">{renameError}</p>}
                <p className="text-slate-500 text-xs mt-1">
                  {group.members.length} members · {isAdminless ? 'admin-less' : (isGroupAdmin ? 'you are admin' : 'you are a member')}
                </p>
              </div>
              <button onClick={() => setShowMembers(false)} className="text-slate-500 hover:text-white transition-colors ml-3 flex-shrink-0">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-2">
              {group.members.map((m) => {
                const isSelf = m.peerId === localPeerId;
                const label = m.username ? `@${m.username}` : m.peerId.slice(0, 12) + '…';
                return (
                  <div
                    key={m.peerId}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl"
                  >
                    <div className="w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">
                      {(m.username ?? m.peerId)[0]?.toUpperCase() ?? '?'}
                    </div>
                    <span className="text-white text-sm flex-1">
                      {label}
                      {isSelf && <span className="text-slate-500 text-xs ml-1">(you)</span>}
                      {m.role === 'admin' && !isAdminless && <span className="text-brand-400 text-xs ml-2">admin</span>}
                    </span>
                    {isGroupAdmin && !isSelf && onKickMember && (
                      <button
                        onClick={() => { onKickMember(m.peerId); }}
                        title="Remove from group"
                        className="text-xs px-2 py-1 rounded-md bg-slate-800 hover:bg-red-700 text-slate-400 hover:text-white transition-colors"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Add-member picker (group admin only) */}
      {showAddMember && group && onAddMember && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => setShowAddMember(false)} />
          <div className="relative bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-sm flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
              <h2 className="text-white font-semibold text-sm">Add member</h2>
              <button onClick={() => setShowAddMember(false)} className="text-slate-500 hover:text-white transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-2">
              {!addableContacts || addableContacts.length === 0 ? (
                <p className="text-slate-500 text-sm text-center py-6">No contacts available to add.</p>
              ) : (
                addableContacts.map((c) => (
                  <button
                    key={c.peerId}
                    onClick={() => { onAddMember(c.peerId); setShowAddMember(false); }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-800 transition-colors text-left"
                  >
                    <div className="w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">
                      {c.displayName[0]?.toUpperCase() ?? '?'}
                    </div>
                    <span className="text-white text-sm">{c.displayName}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Admin-leave handoff: pick a successor or convert to adminless */}
      {adminChoice === 'choose' && group && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => setAdminChoice('idle')} />
          <div className="relative bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-sm flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
              <h2 className="text-white font-semibold text-sm">Before you leave</h2>
              <button onClick={() => setAdminChoice('idle')} className="text-slate-500 hover:text-white transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="px-5 py-4 border-b border-slate-800 text-sm text-slate-400">
              You're the admin of <span className="text-white">{group.name}</span>. Choose a successor or make the group admin-less so anyone can add members.
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-2">
              <p className="text-slate-500 text-xs uppercase tracking-widest font-medium px-3 pt-2 pb-1">Nominate admin</p>
              {otherMembers.length === 0 ? (
                <p className="text-slate-600 text-sm px-3 py-2">No other members.</p>
              ) : (
                otherMembers.map((m) => (
                  <button
                    key={m.peerId}
                    onClick={() => { void chooseSuccessor(m.peerId); }}
                    data-testid="admin-handoff-successor"
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-800 transition-colors text-left"
                  >
                    <div className="w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">
                      {(m.username ?? m.peerId)[0]?.toUpperCase() ?? '?'}
                    </div>
                    <span className="text-white text-sm">{m.username ? `@${m.username}` : m.peerId.slice(0, 12) + '…'}</span>
                  </button>
                ))
              )}
            </div>
            <div className="px-5 py-4 border-t border-slate-800">
              <button
                onClick={() => { void chooseAdminless(); }}
                data-testid="admin-handoff-adminless"
                className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-medium transition-colors"
              >
                Make admin-less and leave
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete / Leave confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => setConfirmDelete(false)} />
          <div className="relative bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-xs p-6 text-center">
            <p className="text-white font-medium mb-1">{group ? 'Leave group?' : 'Delete conversation?'}</p>
            <p className="text-slate-400 text-sm mb-5">
              {group
                ? <>The other members will be told you left. Your local copy of {contact.displayName} and its messages will be removed.</>
                : <>This will remove {contact.displayName} and all messages locally. This cannot be undone.</>}
            </p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDelete(false)} className="flex-1 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm font-medium transition-colors">Cancel</button>
              <button onClick={() => { setConfirmDelete(false); onRemove(); }} className="flex-1 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition-colors">{group ? 'Leave' : 'Delete'}</button>
            </div>
          </div>
        </div>
      )}

      {/* Message actions (reactions + reply + forward) */}
      {actionsMenuFor && (() => {
        const targetMsg = messages.find((m) => m.id === actionsMenuFor);
        if (!targetMsg) { setActionsMenuFor(null); return null; }
        const presetReactions = ['👍', '❤️', '😂', '🎉', '😢', '🙏'];
        return (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => setActionsMenuFor(null)} />
            <div className="relative bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-sm overflow-hidden">
              {onReact && (
                <div className="px-4 py-3 border-b border-slate-800">
                  <div className="flex gap-2 justify-around">
                    {presetReactions.map((emoji) => (
                      <button
                        key={emoji}
                        onClick={() => { void onReact(targetMsg.id, emoji); setActionsMenuFor(null); }}
                        className="w-10 h-10 rounded-full text-xl hover:bg-slate-800 transition-colors flex items-center justify-center"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button
                onClick={() => {
                  const snippet = (targetMsg.text || '').slice(0, 80);
                  setReplyContext({ messageId: targetMsg.id, snippetText: snippet });
                  setActionsMenuFor(null);
                }}
                className="w-full px-5 py-3 text-left text-white text-sm hover:bg-slate-800 transition-colors flex items-center gap-3"
              >
                <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" />
                </svg>
                Reply
              </button>
              {onForwardMessage && (
                <button
                  onClick={() => { setForwardingMessageId(targetMsg.id); setActionsMenuFor(null); }}
                  className="w-full px-5 py-3 text-left text-white text-sm hover:bg-slate-800 transition-colors flex items-center gap-3"
                >
                  <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 0 1 0 1.954l-7.108 4.061A1.125 1.125 0 0 1 3 16.811V8.69ZM12.75 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 0 1 0 1.954l-7.108 4.061a1.125 1.125 0 0 1-1.683-.977V8.69Z" />
                  </svg>
                  Forward
                </button>
              )}
              <button
                onClick={() => { void navigator.clipboard.writeText(targetMsg.text); setActionsMenuFor(null); }}
                className="w-full px-5 py-3 text-left text-white text-sm hover:bg-slate-800 transition-colors flex items-center gap-3"
              >
                <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75" />
                </svg>
                Copy text
              </button>
            </div>
          </div>
        );
      })()}

      {/* Forwarding contact picker */}
      {forwardingMessageId && onForwardMessage && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => setForwardingMessageId(null)} />
          <div className="relative bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-sm flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
              <h2 className="text-white font-semibold text-sm">Forward to…</h2>
              <button onClick={() => setForwardingMessageId(null)} className="text-slate-500 hover:text-white">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 py-2">
              {!forwardTargets || forwardTargets.length === 0 ? (
                <p className="text-slate-500 text-sm text-center py-6">No other contacts to forward to.</p>
              ) : (
                forwardTargets.map((c) => (
                  <button
                    key={c.peerId}
                    onClick={() => { void onForwardMessage(forwardingMessageId, c.peerId); setForwardingMessageId(null); }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-slate-800 transition-colors text-left"
                  >
                    <div className="w-8 h-8 rounded-full bg-brand-600 flex items-center justify-center text-white text-xs font-semibold flex-shrink-0">
                      {c.displayName[0]?.toUpperCase() ?? '?'}
                    </div>
                    <span className="text-white text-sm">{c.displayName}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Disappearing-messages picker */}
      {showDisappearingPicker && onSetDisappearing && (() => {
        const options: Array<{ label: string; ttlMs: number | null }> = [
          { label: 'Off', ttlMs: null },
          { label: '1 hour', ttlMs: 60 * 60_000 },
          { label: '1 day', ttlMs: 24 * 60 * 60_000 },
          { label: '7 days', ttlMs: 7 * 24 * 60 * 60_000 },
          { label: '30 days', ttlMs: 30 * 24 * 60 * 60_000 },
        ];
        return (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
            <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm" onClick={() => setShowDisappearingPicker(false)} />
            <div className="relative bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-sm flex flex-col">
              <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
                <div>
                  <h2 className="text-white font-semibold text-sm">Disappearing messages</h2>
                  <p className="text-slate-500 text-xs mt-0.5">New messages will auto-delete after the chosen time.</p>
                </div>
                <button onClick={() => setShowDisappearingPicker(false)} className="text-slate-500 hover:text-white flex-shrink-0">
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="py-2">
                {options.map((opt) => {
                  const active = (disappearingTtlMs ?? null) === opt.ttlMs;
                  return (
                    <button
                      key={opt.label}
                      onClick={() => { void onSetDisappearing(opt.ttlMs); setShowDisappearingPicker(false); }}
                      className={`w-full px-5 py-2.5 text-left text-sm hover:bg-slate-800 transition-colors flex items-center justify-between ${active ? 'text-brand-400' : 'text-white'}`}
                    >
                      <span>{opt.label}</span>
                      {active && (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Lightbox */}
      {lightboxUrl && (
        <div className="fixed inset-0 z-50 bg-slate-950/95 flex items-center justify-center p-4" onClick={() => setLightboxUrl(null)}>
          <img src={lightboxUrl} alt="Photo" className="max-w-full max-h-full object-contain rounded-xl" />
          <button className="absolute top-4 right-4 w-9 h-9 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 hover:text-white">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 scrollable px-4 py-4 space-y-1">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="text-slate-600 text-sm text-center">
              {group
                ? <>This is the beginning of <br /><span className="font-medium">{contact.displayName}</span>.</>
                : <>This is the beginning of your encrypted conversation<br />with {contact.displayName}.</>
              }
            </p>
          </div>
        )}
        {messages.map((msg, i) => {
          const isOut = msg.direction === 'outbound';
          const prev = messages[i - 1];
          // "Grouped" means the message visually attaches to the previous one
          // (no name label, tighter spacing). It must be the SAME sender —
          // otherwise two different group members messaging back-to-back
          // appear as a single user's burst.
          const grouped =
            prev?.direction === msg.direction &&
            msg.timestamp - prev.timestamp < 60_000 &&
            // For inbound: same group senderId. For DMs both have undefined senderId, which is fine — same conversation peer.
            prev.senderId === msg.senderId;
          const hasMedia = !!msg.media;
          const isImage = hasMedia && isImageMime(msg.media!.mimeType);

          const reactionEntries = Object.entries(msg.reactions ?? {}).filter(([, peers]) => peers.length > 0);
          const showActions = isDM && (onReact || onForwardMessage);

          return (
            <div key={msg.id} className={`group flex ${isOut ? 'justify-end' : 'justify-start'} ${grouped ? 'mt-0.5' : 'mt-3'}`}>
              <div className={`max-w-[75%] ${isOut ? 'items-end' : 'items-start'} flex flex-col`}>
                {!isOut && !grouped && msg.senderName && (
                  <span className="text-brand-400 text-[10px] font-medium mb-0.5 px-1">{msg.senderName}</span>
                )}

                {msg.forwardedFrom && (
                  <span className="text-slate-500 text-[10px] italic px-1 mb-0.5 flex items-center gap-1">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 0 1 0 1.954l-7.108 4.061A1.125 1.125 0 0 1 3 16.811V8.69ZM12.75 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 0 1 0 1.954l-7.108 4.061a1.125 1.125 0 0 1-1.683-.977V8.69Z" />
                    </svg>
                    Forwarded
                  </span>
                )}

                {msg.replyTo && (
                  <div className={`px-2.5 py-1 mb-0.5 rounded-lg max-w-full border-l-2 ${isOut ? 'bg-brand-700/40 border-brand-300' : 'bg-slate-700/50 border-slate-500'}`}>
                    <p className="text-[10px] uppercase tracking-widest text-slate-400">Reply</p>
                    <p className={`text-xs truncate ${isOut ? 'text-brand-100' : 'text-slate-300'}`}>{msg.replyTo.snippetText ?? '…'}</p>
                  </div>
                )}

                <div className="relative flex items-center gap-1.5 group/bubble">
                  {showActions && isOut && (
                    <button
                      onClick={() => setActionsMenuFor(msg.id)}
                      title="Message actions"
                      className="opacity-0 group-hover/bubble:opacity-100 transition-opacity w-7 h-7 flex items-center justify-center rounded-full text-slate-500 hover:bg-slate-800 hover:text-slate-200 flex-shrink-0"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0H5.25m7.5 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h-1.5m7.5 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h-1.5" />
                      </svg>
                    </button>
                  )}

                  {hasMedia && isImage && (
                    <ImageBubble msg={msg} isOut={isOut} onDownload={() => { void handleImageTap(msg); }} />
                  )}
                  {hasMedia && !isImage && (
                    <FileBubble msg={msg} isOut={isOut} onDownload={() => { if (onDownloadMedia) void onDownloadMedia(msg.id); }} />
                  )}
                  {!hasMedia && (
                    <div className={`px-3.5 py-2 rounded-2xl text-sm leading-relaxed ${isOut ? 'bg-brand-600 text-white rounded-br-sm' : 'bg-slate-800 text-slate-100 rounded-bl-sm'}`}>
                      {msg.text}
                    </div>
                  )}

                  {showActions && !isOut && (
                    <button
                      onClick={() => setActionsMenuFor(msg.id)}
                      title="Message actions"
                      className="opacity-0 group-hover/bubble:opacity-100 transition-opacity w-7 h-7 flex items-center justify-center rounded-full text-slate-500 hover:bg-slate-800 hover:text-slate-200 flex-shrink-0"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 12a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0H5.25m7.5 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h-1.5m7.5 0a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 0h-1.5" />
                      </svg>
                    </button>
                  )}
                </div>

                {reactionEntries.length > 0 && (
                  <div className={`flex flex-wrap gap-1 mt-1 ${isOut ? 'justify-end' : 'justify-start'}`}>
                    {reactionEntries.map(([emoji, peers]) => {
                      const mine = localPeerId ? peers.includes(localPeerId) : false;
                      return (
                        <button
                          key={emoji}
                          onClick={() => { if (onReact) void onReact(msg.id, emoji); }}
                          className={`px-1.5 py-0.5 rounded-full text-xs flex items-center gap-1 transition-colors ${mine ? 'bg-brand-600/40 border border-brand-500' : 'bg-slate-800 border border-slate-700 hover:bg-slate-700'}`}
                          title={mine ? 'Remove your reaction' : 'Add your reaction'}
                        >
                          <span>{emoji}</span>
                          <span className="text-slate-300 text-[10px]">{peers.length}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {!grouped && (
                  <div className={`flex items-center gap-1 mt-1 ${isOut ? 'flex-row-reverse' : ''}`}>
                    <span className="text-slate-600 text-[10px]">{formatTimestamp(msg.timestamp)}</span>
                    {isOut && <StatusIcon status={msg.status} />}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {isTyping && (
          <div className="flex justify-start mt-3">
            <div className="bg-slate-800 rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1 items-center">
              {[0, 1, 2].map((i) => (
                <div key={i} className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Reply preview (above composer) */}
      {replyContext && (
        <div className="border-t border-slate-800 bg-slate-900 px-4 py-2 flex items-center gap-2">
          <div className="w-1 h-8 bg-brand-500 rounded-full flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-brand-400 text-[10px] font-medium uppercase tracking-widest">Replying to</p>
            <p className="text-slate-300 text-xs truncate">{replyContext.snippetText ?? '…'}</p>
          </div>
          <button
            onClick={() => setReplyContext(null)}
            title="Cancel reply"
            className="text-slate-500 hover:text-white flex-shrink-0"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Compose */}
      <div className="border-t border-slate-800 bg-slate-900 px-4 py-3 flex items-end gap-2">
        {onAttach && (
          <>
            <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" onChange={handleFileChange} />
            <button
              onClick={() => fileRef.current?.click()}
              className="w-9 h-9 flex-shrink-0 rounded-full hover:bg-slate-800 flex items-center justify-center text-slate-500 hover:text-slate-300 transition-colors"
              title="Attach file"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13" />
              </svg>
            </button>
          </>
        )}
        <textarea
          ref={inputRef}
          placeholder="Message"
          rows={1}
          onKeyDown={handleKeyDown}
          onInput={autoResize}
          className="flex-1 bg-slate-800 border border-slate-700 rounded-2xl px-4 py-2.5 text-white placeholder-slate-500 focus:outline-none focus:border-slate-600 transition-colors text-sm resize-none leading-relaxed"
          style={{ height: '40px' }}
        />
        <button
          onClick={submit}
          className="w-9 h-9 flex-shrink-0 bg-brand-500 hover:bg-brand-600 rounded-full flex items-center justify-center transition-colors"
        >
          <svg className="w-4 h-4 text-white translate-x-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" />
          </svg>
        </button>
      </div>
    </div>
  );
}
