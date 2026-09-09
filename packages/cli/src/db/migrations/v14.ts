import type Database from 'better-sqlite3'
import { createReadonlyViews } from '../schema.js'

/** Store source-reported serving gateway/credential metadata without relabeling provider. */
export function migrateV14(db: Database.Database): void {
  const recordColumns = db.prepare("PRAGMA table_info('records')").all() as Array<{ name: string }>
  if (!recordColumns.some(column => column.name === 'gateway')) {
    db.exec('ALTER TABLE records ADD COLUMN gateway TEXT')
  }

  const syncedColumns = db.prepare("PRAGMA table_info('synced_records')").all() as Array<{ name: string }>
  if (!syncedColumns.some(column => column.name === 'gateway')) {
    db.exec('ALTER TABLE synced_records ADD COLUMN gateway TEXT')
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_records_gateway ON records(gateway)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_synced_records_gateway ON synced_records(gateway)')

  // SQLite has no ALTER VIEW. Recreate the read-only views so existing databases
  // expose the new nullable column just like fresh databases do.
  db.exec('DROP VIEW IF EXISTS v_usage_records; DROP VIEW IF EXISTS v_tool_calls; DROP VIEW IF EXISTS v_sessions;')
  createReadonlyViews(db)
  db.prepare('INSERT INTO schema_version (version) VALUES (14)').run()
}
