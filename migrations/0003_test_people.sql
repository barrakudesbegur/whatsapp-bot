-- Test flag: people whose messages arrive via a simulator (the admin Simulador
-- tab or the chat CLI) rather than real WhatsApp. Badged in the admin, can be
-- filtered out there, and excluded from the CSV export of survey results.
ALTER TABLE people ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
