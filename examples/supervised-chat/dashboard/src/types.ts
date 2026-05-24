export interface AuditEntry {
  ts: string;
  observedAt: string;
  groupId: string;
  senderPeerId: string;
  groupSenderId?: string;
  text: string;
}

export interface AuditResponse {
  entries: AuditEntry[];
  count: number;
}
