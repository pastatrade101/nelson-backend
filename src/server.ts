import app from './app';
import { env } from './config/env';
import { loadRolePermissions } from './services/permissions.service';

// Start serving immediately so health checks pass even if the database is slow
// or briefly unreachable at boot. The role→permission map uses built-in defaults
// until the background hydration below completes, after which saved permission
// edits take effect.
app.listen(env.PORT, () => {
  console.log(`Tour website API running at http://localhost:${env.PORT}`);
});

void loadRolePermissions();
