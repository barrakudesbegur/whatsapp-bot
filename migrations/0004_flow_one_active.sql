-- At most one OPEN (active) submission per person per flow. Closes the create
-- race where two concurrent first-touch webhooks each see "no instance" and both
-- INSERT an 'active' row (the older then orphaned by getLatestFlowInstance's
-- ORDER BY id DESC). With this partial unique index the second INSERT violates
-- the constraint; persistSurvey catches that and updates the winner instead.
-- Completed/declined/abandoned rows are unaffected — a person accumulates those
-- over time. Safe on existing data unless a person already has two active rows
-- for one flow (only possible via the very race this prevents); none exist on the
-- POC. Apply to prod with: npm run db:apply:remote
CREATE UNIQUE INDEX idx_flow_one_active
  ON flow_instances (person_id, flow_type)
  WHERE status = 'active';
