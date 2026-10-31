-- P2-4 的 task_state 格式；不读任何真实 Hub 数据库。
CREATE TABLE task_state (
  task TEXT PRIMARY KEY, path TEXT NOT NULL, last_turn TEXT, session TEXT,
  snapshot TEXT, rounds INTEGER NOT NULL DEFAULT 0, pending_since INTEGER
);
CREATE TABLE task_rounds (
  job TEXT PRIMARY KEY, task TEXT NOT NULL, round INTEGER NOT NULL, written INTEGER NOT NULL DEFAULT 0
);
INSERT INTO task_state VALUES ('task_00000000000000000000000021', 'plan/tasks/LegacyActive.md', 'human', NULL, NULL, 0, NULL);
INSERT INTO task_state VALUES ('task_00000000000000000000000022', 'plan/tasks/LegacyDone.md', 'human', NULL, NULL, 0, NULL);
