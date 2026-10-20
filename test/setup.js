// Loaded before every test file. Keeps tests independent of a developer's .env.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-that-is-at-least-32-characters-long'
process.env.NODE_ENV = 'test'
process.env.TEST_PG_URL = process.env.TEST_PG_URL || 'postgres://mben@localhost:5432/birdalert_test'
