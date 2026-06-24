import { runEvals } from '../services/ai-eval.service';
import { purgeAnonymousConversations } from '../services/ai-retention.service';
import { embedCmsContent } from '../services/ai-retrieval.service';
import { purgeOldEvents } from '../services/analytics.service';

// ----------------------------------------------------------------------------
// Nightly AI maintenance (§14, §27, §10). Run from the host's scheduler, e.g.:
//   - cron:   0 2 * * *  cd /app/backend && npm run ai:nightly
//   - or compiled:  node dist/jobs/ai-nightly.js
// Does: purge stale anonymous conversations -> refresh CMS embeddings ->
// run the golden-set eval sweep (LLM-as-judge). Each step is independent.
// ----------------------------------------------------------------------------

const main = async () => {
  console.log('[ai-nightly] start', new Date().toISOString());

  try {
    const purge = await purgeAnonymousConversations();
    console.log('[ai-nightly] retention purge:', purge);
  } catch (err) {
    console.error('[ai-nightly] retention purge failed:', (err as Error).message);
  }

  try {
    const events = await purgeOldEvents();
    console.log('[ai-nightly] analytics events purge:', events);
  } catch (err) {
    console.error('[ai-nightly] analytics events purge failed:', (err as Error).message);
  }

  try {
    const embed = await embedCmsContent();
    console.log('[ai-nightly] embeddings refresh:', embed);
  } catch (err) {
    console.error('[ai-nightly] embeddings refresh failed:', (err as Error).message);
  }

  try {
    const evals = await runEvals();
    console.log('[ai-nightly] eval sweep:', { total: evals.total, passed: evals.passed, failed: evals.failed });
    if (evals.failed > 0) {
      console.error('[ai-nightly] EVAL FAILURES:', evals.failures.map((f) => `${f.scenario_key}(${f.failure_mode})`).join(', '));
    }
  } catch (err) {
    console.error('[ai-nightly] eval sweep failed:', (err as Error).message);
  }

  console.log('[ai-nightly] done', new Date().toISOString());
  process.exit(0);
};

void main().catch((err) => {
  console.error('[ai-nightly] fatal:', err);
  process.exit(1);
});
