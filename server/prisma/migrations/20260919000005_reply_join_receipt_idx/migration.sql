-- reply-join: covering index for drain check (countPendingFor: fromInstanceId+teamId+status)
CREATE INDEX idx_message_receipts_from_status ON message_receipts (from_instance_id, team_id, status);
