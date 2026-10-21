import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { getQueryString } from '../utils/query';
import {
  isLinkType,
  repairMovedLinks,
  resolveLinkRefs,
  scanLinkHealth,
  searchLinkTargets
} from '../services/internal-links.service';

/** GET /api/internal-links/search?q=&type=&page=&limit= — published pages to link to. */
export const searchInternalLinks = asyncHandler(async (req, res) => {
  const type = getQueryString(req.query, 'type');
  if (type && type !== 'all' && !isLinkType(type)) throw new AppError('Unknown content type.', 400);
  const result = await searchLinkTargets({
    q: getQueryString(req.query, 'q'),
    type: type && type !== 'all' && isLinkType(type) ? type : undefined,
    page: Number(getQueryString(req.query, 'page')) || 1,
    limit: Number(getQueryString(req.query, 'limit')) || 20
  });
  return sendSuccess(res, 'Link targets fetched successfully.', result);
});

/**
 * GET /api/internal-links/resolve?refs=tours:<id>,destinations:<id> — where each
 * referenced page is now. A GET, not a POST: every non-visitor POST empties the
 * public API cache, and this runs each time an editor opens a text.
 */
export const resolveInternalLinks = asyncHandler(async (req, res) => {
  const refs = getQueryString(req.query, 'refs')
    .split(',')
    .slice(0, 60)
    .map((pair) => {
      const [type, id] = pair.split(':');
      return { type: (type ?? '').trim(), id: (id ?? '').trim() };
    })
    .filter((ref) => ref.type && ref.id);
  return sendSuccess(res, 'Link references resolved.', await resolveLinkRefs(refs));
});

/** GET /api/internal-links/health — every link in tour and itinerary copy, checked. */
export const internalLinkHealth = asyncHandler(async (_req, res) => {
  return sendSuccess(res, 'Link health checked.', await scanLinkHealth());
});

/** POST /api/internal-links/repair — repoint links whose page's slug changed. */
export const repairInternalLinks = asyncHandler(async (_req, res) => {
  return sendSuccess(res, 'Moved links updated.', await repairMovedLinks());
});
