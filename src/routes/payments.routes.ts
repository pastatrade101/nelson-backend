import { Router } from 'express';
import { createPayment, deletePayment, getPayment, listPayments, updatePayment } from '../controllers/payments.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { paymentCreateSchema, paymentUpdateSchema } from '../schemas/payments.schema';

const router = Router();

router.use(authenticate);
router.get('/', requirePermission('payments.view'), listPayments);
router.get('/:id', requirePermission('payments.view'), getPayment);
router.post('/', requirePermission('payments.create'), validate({ body: paymentCreateSchema }), createPayment);
router.put('/:id', requirePermission('payments.update'), validate({ body: paymentUpdateSchema }), updatePayment);
router.delete('/:id', requirePermission('payments.refund'), deletePayment);

export default router;
