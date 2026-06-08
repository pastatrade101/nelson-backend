import { Router } from 'express';
import { listPublicDepartures } from '../controllers/departures.controller';

const router = Router();

// Public departure inventory (sourced from available_dates + published tours).
router.get('/', listPublicDepartures);

export default router;
