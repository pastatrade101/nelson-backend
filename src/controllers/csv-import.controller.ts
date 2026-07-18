import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { ENTITIES, RESET_TABLES, buildTemplate, hasPermission, importEntity, listEntities, resetContent } from '../services/csv-import.service';

/** GET /api/import/entities — the importable entity types (for the admin UI). */
export const getImportEntities = asyncHandler(async (_req, res) => {
  return sendSuccess(res, 'Import entities fetched.', { entities: listEntities() });
});

/** GET /api/import/:entity/template — a downloadable CSV template with one example row. */
export const getImportTemplate = asyncHandler(async (req, res) => {
  const entity = req.params.entity;
  if (!ENTITIES[entity]) throw new AppError(`Unknown import type "${entity}".`, 404);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="emnel-${entity}-template.csv"`);
  return res.send(buildTemplate(entity));
});

/** POST /api/import/:entity — import a CSV (multipart "file" or JSON "csv" body). */
export const importCsvEntity = asyncHandler(async (req, res) => {
  const entity = req.params.entity;
  const known = entity === 'itineraries' || entity === 'tours' || Boolean(ENTITIES[entity]);
  if (!known) throw new AppError(`Unknown import type "${entity}".`, 404);

  if (!req.user) throw new AppError('Authentication is required.', 401);
  if (!hasPermission(req.user.role, entity)) throw new AppError('You do not have permission to import this content.', 403);

  let csvText: string | undefined;
  if (req.file) csvText = req.file.buffer.toString('utf8');
  else if (typeof (req.body as { csv?: unknown })?.csv === 'string') csvText = (req.body as { csv: string }).csv;
  if (!csvText || !csvText.trim()) throw new AppError('Provide a CSV file (form field "file") or a "csv" text body.', 400);

  const result = await importEntity(entity, csvText, req.user.sub);
  return sendSuccess(
    res,
    `Imported ${result.summary.created} new and ${result.summary.updated} updated (${result.summary.failed} failed).`,
    result
  );
});

/** GET /api/import/reset — what a content reset would clear (for the confirm UI). */
export const getResetInfo = asyncHandler(async (_req, res) => {
  return sendSuccess(res, 'Reset scope fetched.', { tables: [...RESET_TABLES] });
});

/**
 * POST /api/import/reset — DANGER: hard-delete all importable content so the
 * client can start fresh. Super-admin only, and the body must include
 * { confirm: "RESET" }. Leaves users, roles, branding, settings and homepage.
 */
export const resetContentData = asyncHandler(async (req, res) => {
  if (!req.user) throw new AppError('Authentication is required.', 401);
  if (req.user.role !== 'super_admin') throw new AppError('Only a super admin can reset content.', 403);
  if ((req.body as { confirm?: unknown })?.confirm !== 'RESET') {
    throw new AppError('Type RESET to confirm — nothing was deleted.', 400);
  }

  const results = await resetContent();
  const total = results.reduce((n, r) => n + r.deleted, 0);
  const failed = results.filter((r) => r.error);
  return sendSuccess(res, `Content reset — ${total} records deleted${failed.length ? `, ${failed.length} table(s) failed` : ''}.`, {
    total,
    results
  });
});
