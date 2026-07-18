import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { importItineraries } from '../services/itinerary-import.service';

/**
 * POST /api/itinerary-import
 * Accepts a CSV either as a multipart file (field "file") or as a raw string in
 * the JSON body ("csv"). Each row becomes a full itinerary (tour + type + days +
 * inclusions/exclusions + pricing tiers). Returns a per-row result report.
 */
export const importItinerariesCsv = asyncHandler(async (req, res) => {
  let csvText: string | undefined;
  if (req.file) csvText = req.file.buffer.toString('utf8');
  else if (typeof (req.body as { csv?: unknown })?.csv === 'string') csvText = (req.body as { csv: string }).csv;

  if (!csvText || !csvText.trim()) {
    throw new AppError('Provide a CSV file (form field "file") or a "csv" text body.', 400);
  }

  const result = await importItineraries(csvText, req.user?.sub);
  return sendSuccess(
    res,
    `Imported ${result.summary.created} new and ${result.summary.updated} updated itineraries (${result.summary.failed} failed).`,
    result
  );
});
