CREATE TABLE IF NOT EXISTS round_agents (
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  subagent_type TEXT,
  spawn_depth INTEGER,
  status TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_input_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  duration_ms INTEGER,
  tool_uses INTEGER,
  tool_uses_by_name TEXT,
  file_paths TEXT,
  PRIMARY KEY (session_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_round_agents_session ON round_agents (session_id);
