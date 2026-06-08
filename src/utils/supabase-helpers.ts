import type { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import { safeAudit } from '../services/audit.service';
import { createUniqueSlug } from '../services/slug.service';
import { AppError, sendSuccess } from './api-response';
import { cleanSearch, getPagination, getQueryString, paginationMeta } from './query';

type ListOptions = {
  table: string;
  select?: string;
  searchColumns?: string[];
  statusColumn?: string;
  defaultStatus?: string;
  softDelete?: boolean;
  orderBy?: string;
  ascending?: boolean;
  filters?: string[];
};

export const listRecords = async (req: Request, res: Response, options: ListOptions) => {
  const { page, limit, from, to } = getPagination(req.query);
  const search = cleanSearch(getQueryString(req.query, 'search'));
  const status = getQueryString(req.query, 'status');

  let query = supabase
    .from(options.table)
    .select(options.select ?? '*', { count: 'exact' })
    .order(options.orderBy ?? 'created_at', { ascending: options.ascending ?? false });

  if (options.softDelete ?? true) query = query.is('deleted_at', null);
  if (search && options.searchColumns?.length) {
    query = query.or(options.searchColumns.map((column) => `${column}.ilike.%${search}%`).join(','));
  }

  if (options.statusColumn) {
    if (status && status !== 'all') query = query.eq(options.statusColumn, status);
    else if (!status && options.defaultStatus) query = query.eq(options.statusColumn, options.defaultStatus);
  }

  for (const filter of options.filters ?? []) {
    const value = getQueryString(req.query, filter);
    if (value && value !== 'all') query = query.eq(filter, value);
  }

  const { data, error, count } = await query.range(from, to);
  if (error) throw new AppError(`Unable to fetch ${options.table}.`, 500, [error]);

  return sendSuccess(res, 'Records fetched successfully.', {
    items: data ?? [],
    pagination: paginationMeta(page, limit, count ?? 0)
  });
};

export const getRecordBySlug = async (res: Response, table: string, slug: string, select = '*') => {
  const { data, error } = await supabase
    .from(table)
    .select(select)
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) throw new AppError(`Unable to fetch ${table}.`, 500, [error]);
  if (!data) throw new AppError('Record not found.', 404);

  return sendSuccess(res, 'Record fetched successfully.', data);
};

export const getRecordById = async (res: Response, table: string, id: string, select = '*') => {
  const { data, error } = await supabase
    .from(table)
    .select(select)
    .eq('id', id)
    .maybeSingle();

  if (error) throw new AppError(`Unable to fetch ${table}.`, 500, [error]);
  if (!data) throw new AppError('Record not found.', 404);

  return sendSuccess(res, 'Record fetched successfully.', data);
};

export const createRecord = async (
  req: Request,
  res: Response,
  table: string,
  body: Record<string, unknown>,
  options: { slugSource?: string; userFields?: boolean } = {}
) => {
  const payload = { ...body };

  if (options.slugSource) {
    const source = String(payload.slug || payload[options.slugSource]);
    payload.slug = await createUniqueSlug(table, source);
  }

  if (options.userFields && req.user) {
    payload.created_by = req.user.sub;
    payload.updated_by = req.user.sub;
  }

  const { data, error } = await supabase.from(table).insert(payload).select('*').single();
  if (error) throw new AppError(`Unable to create ${table}.`, 500, [error]);

  await safeAudit({ action: 'create', entityId: data?.id, entityType: table, newData: data, req });

  return sendSuccess(res, 'Record created successfully.', data, 201);
};

export const updateRecord = async (
  req: Request,
  res: Response,
  table: string,
  id: string,
  body: Record<string, unknown>,
  options: { slugSource?: string; userFields?: boolean } = {}
) => {
  const payload = { ...body };

  if (options.slugSource && payload.slug) {
    payload.slug = await createUniqueSlug(table, String(payload.slug), id);
  }

  if (options.userFields && req.user) {
    payload.updated_by = req.user.sub;
  }

  const { data: previous } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
  const { data, error } = await supabase.from(table).update(payload).eq('id', id).select('*').single();
  if (error) throw new AppError(`Unable to update ${table}.`, 500, [error]);

  await safeAudit({ action: 'update', entityId: id, entityType: table, newData: data, oldData: previous, req });

  return sendSuccess(res, 'Record updated successfully.', data);
};

export const softDeleteRecord = async (res: Response, table: string, id: string, req?: Request) => {
  const { data: previous } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
  const { error } = await supabase
    .from(table)
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw new AppError(`Unable to delete ${table}.`, 500, [error]);

  await safeAudit({ action: 'delete', entityId: id, entityType: table, oldData: previous, req });

  return sendSuccess(res, 'Record deleted successfully.');
};

export const deleteRecord = async (res: Response, table: string, id: string, req?: Request) => {
  const { data: previous } = await supabase.from(table).select('*').eq('id', id).maybeSingle();
  const { error } = await supabase.from(table).delete().eq('id', id);
  if (error) throw new AppError(`Unable to delete ${table}.`, 500, [error]);

  await safeAudit({ action: 'delete', entityId: id, entityType: table, oldData: previous, req });

  return sendSuccess(res, 'Record deleted successfully.');
};
