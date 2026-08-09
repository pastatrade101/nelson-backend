import { Router } from 'express';
import { getCurrencies } from '../controllers/currencies.controller';

const router = Router();

router.get('/', getCurrencies);

export default router;
