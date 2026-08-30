ALTER TABLE jobs
  ADD COLUMN payout_amount DECIMAL(15,2) NOT NULL DEFAULT 0.00 AFTER revenue_game,
  ADD COLUMN client_submission_id CHAR(36) NULL AFTER payout_amount,
  ADD UNIQUE KEY uq_jobs_client_submission (driver_user_id, client_submission_id);

ALTER TABLE payouts
  ADD COLUMN application_id CHAR(36) NULL AFTER lease_expires_at,
  ADD COLUMN confirmed_balance_before DECIMAL(15,2) NULL AFTER application_id,
  ADD COLUMN confirmed_balance_after DECIMAL(15,2) NULL AFTER confirmed_balance_before,
  ADD UNIQUE KEY uq_payout_application_id (application_id),
  ADD KEY idx_payout_lease (status, lease_expires_at);

CREATE TABLE schema_migrations (
  version VARCHAR(80) NOT NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
