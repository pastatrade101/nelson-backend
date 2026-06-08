import { asyncHandler } from '../utils/async-handler';
import { createRecord, getRecordById, listRecords, softDeleteRecord, updateRecord } from '../utils/supabase-helpers';

const select = '*, booking_requests(booking_code,full_name,email,status)';

export const listPayments = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'booking_payments',
    select,
    searchColumns: ['transaction_reference', 'payment_provider', 'payment_method'],
    statusColumn: 'status',
    filters: ['booking_id']
  });
});

export const getPayment = asyncHandler(async (req, res) => getRecordById(res, 'booking_payments', req.params.id, select));

export const createPayment = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'booking_payments', req.body, { userFields: true });
});

export const updatePayment = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'booking_payments', req.params.id, req.body);
});

export const deletePayment = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'booking_payments', req.params.id, req);
});
