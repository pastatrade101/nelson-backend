import app from './app';
import { env } from './config/env';
import { loadRolePermissions } from './services/permissions.service';

const start = async () => {
  // Hydrate the runtime role→permission map from the database before serving.
  await loadRolePermissions();

  app.listen(env.PORT, () => {
    console.log(`Tour website API running at http://localhost:${env.PORT}`);
  });
};

void start();
