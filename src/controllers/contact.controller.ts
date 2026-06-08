import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { cleanSearch, getPagination, getQueryString, paginationMeta } from '../utils/query';
import { getRecordById, softDeleteRecord } from '../utils/supabase-helpers';

export const createContactMessage = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('contact_messages')
    .insert({ ...req.body, status: 'new' })
    .select('*')
    .single();

  if (error) throw new AppError('Unable to submit contact message.', 500, [error]);
  return sendSuccess(res, 'Contact message submitted successfully.', data, 201);
});

export const listContactMessages = asyncHandler(async (req, res) => {
  const { page, limit, from, to } = getPagination(req.query);
  const search = cleanSearch(getQueryString(req.query, 'search'));
  const status = getQueryString(req.query, 'status');

  let query = supabase
    .from('contact_messages')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false });

  if (search) {
    query = query.or(
      ['full_name', 'email', 'phone', 'subject', 'message']
        .map((column) => `${column}.ilike.%${search}%`)
        .join(',')
    );
  }
  if (status && status !== 'all') query = query.eq('status', status);

  const { data, error, count } = await query.range(from, to);
  if (error) throw new AppError('Unable to fetch contact messages.', 500, [error]);

  return sendSuccess(res, 'Contact messages fetched successfully.', {
    items: data ?? [],
    pagination: paginationMeta(page, limit, count ?? 0)
  });
});

export const getContactMessage = asyncHandler(async (req, res) => {
  return getRecordById(res, 'contact_messages', req.params.id);
});

export const updateContactMessageStatus = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('contact_messages')
    .update(req.body)
    .eq('id', req.params.id)
    .select('*')
    .single();

  if (error) throw new AppError('Unable to update contact message status.', 500, [error]);
  return sendSuccess(res, 'Contact message status updated successfully.', data);
});

export const assignContactMessage = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('contact_messages')
    .update({ assigned_to: req.body.assigned_to || null })
    .eq('id', req.params.id)
    .select('*')
    .single();

  if (error) throw new AppError('Unable to assign contact message.', 500, [error]);
  return sendSuccess(res, 'Contact message assigned successfully.', data);
});

export const updateContactMessageNotes = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('contact_messages')
    .update({ admin_notes: req.body.admin_notes ?? null })
    .eq('id', req.params.id)
    .select('*')
    .single();

  if (error) throw new AppError('Unable to update contact message notes.', 500, [error]);
  return sendSuccess(res, 'Contact message notes updated successfully.', data);
});

export const deleteContactMessage = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'contact_messages', req.params.id, req);
});
