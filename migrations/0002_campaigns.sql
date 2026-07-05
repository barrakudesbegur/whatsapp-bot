-- Campaigns: what the association is currently pushing (0..N active at a time).
-- Kudi reads the ACTIVE ones each turn and gently steers greetings / "what can
-- you do?" / "what's going on?" toward them. Managed from the admin inbox.
CREATE TABLE campaigns (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  pitch_md TEXT NOT NULL,               -- short pitch Kudi weaves into conversation
  active INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,  -- higher = mentioned first when several are active
  updated_at TEXT NOT NULL
);

-- Seed: the sardanes-course demand survey is the campaign that exists today.
INSERT INTO campaigns (slug, title, pitch_md, active, priority, updated_at) VALUES
  ('curs-sardanes', 'Curs de sardanes',
   'Estem explorant muntar un curs per aprendre a ballar sardanes a Begur. Estem recollint qui s''hi apuntaria amb una mini-enquesta per WhatsApp (tu mateix la pots fer!).',
   1, 10, datetime('now'));
