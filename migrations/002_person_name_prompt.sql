-- Track one-time owner prompts for unknown numeric contact labels.
ALTER TABLE people ADD COLUMN IF NOT EXISTS name_prompted_at TIMESTAMPTZ;
