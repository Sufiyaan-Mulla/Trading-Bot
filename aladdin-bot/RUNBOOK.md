# Aladdin Bot — Operational Runbook (Fix #105)

## Bot Not Responding
1. Check `pm2 status` — if ERRORED, check `pm2 logs aladdin-trading --lines 50`
2. Check `trade_logs/global_halt.json` — if exists, engine is halted. Delete to resume.
3. Restart: `pm2 restart aladdin-trading`

## Manually Closing an OANDA Position
1. Log in to OANDA practice/live portal
2. Close position from UI — bot will detect on next reconciliation tick
3. OR: `node -e "const {OandaAdapter}=require('./exchange-interface'); new OandaAdapter().closeAll().then(console.log)"`

## After a Global Halt
1. Investigate: `cat trade_logs/global_halt.json`
2. Review recent trades: `node -e "const db=require('./db-store'); console.log(db.getTrades('EURUSD',20))"`
3. Reset: `rm trade_logs/global_halt.json && pm2 restart aladdin-trading`

## Daily Loss Lockout
1. `cat trade_logs/daily_lockout.json`
2. Wait for auto-reset at 17:00 NY time, OR:
3. `node auto-reset.js --force` (requires human review first)

## Escalation Path
1. Developer on call → review Telegram alerts + audit log
2. If unresolvable within 30 min → manually close all positions on OANDA portal
3. Notify ops lead

## Key Files
- `trade_logs/audit.jsonl` — immutable HMAC-signed trade audit trail
- `trade_logs/global_halt.json` — global halt flag (delete to resume)
- `trade_logs/daily_lockout.json` — daily loss lockout
- `config/overrides.json` — live parameter overrides (hot-reload)
