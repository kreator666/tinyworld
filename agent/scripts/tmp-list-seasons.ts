import { getDb, closeDb } from '../src/db/index.js'

async function main() {
  const db = await getDb()
  const seasons = await db.query(
    'SELECT id, chain_key, status, config, start_ts, end_ts FROM arena_seasons ORDER BY start_ts DESC LIMIT 5'
  )
  console.log('SEASONS:', JSON.stringify(seasons.rows, null, 2))

  const accounts = await db.query(
    'SELECT season_id, token_id, owner, account_address, phase, nav_usd FROM arena_accounts ORDER BY created_at DESC LIMIT 20'
  )
  console.log('ACCOUNTS:', JSON.stringify(accounts.rows, null, 2))

  const due = await db.query(
    'SELECT season_id, token_id, kind, due_ts, priority, status FROM arena_due ORDER BY due_ts DESC LIMIT 20'
  )
  console.log('DUE:', JSON.stringify(due.rows, null, 2))

  await closeDb()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
