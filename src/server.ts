import app from './app';
import { env } from './config/env';
import { loadRolePermissions } from './services/permissions.service';
import { startExchangeRateScheduler } from './services/exchange-rate-scheduler.service';

// Start serving immediately so health checks pass even if the database is slow
// or briefly unreachable at boot. The role→permission map uses built-in defaults
// until the background hydration below completes, after which saved permission
// edits take effect.
app.listen(env.PORT, () => {
  console.log(`Tour website API running at http://localhost:${env.PORT}`);
});

void loadRolePermissions();

// Refresh currency exchange rates on the configured schedule (no-op without
// OPEN_EXCHANGE_RATES_APP_ID or when EXCHANGE_RATE_REFRESH_ENABLED is false).
startExchangeRateScheduler();
