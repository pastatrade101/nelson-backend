import type { Request, Response } from 'express';
import {
  createRecord,
  deleteRecord,
  getRecordById,
  getRecordBySlug,
  listRecords,
  softDeleteRecord,
  updateRecord
} from './supabase-helpers';

type CrudOptions = {
  defaultStatus?: string;
  filters?: string[];
  orderBy?: string;
  searchColumns?: string[];
  select?: string;
  slugSource?: string;
  softDelete?: boolean;
  statusColumn?: string;
  table: string;
  userFields?: boolean;
};

export const listCrud = (options: CrudOptions) => (req: Request, res: Response) => listRecords(req, res, options);

export const getCrudById = (options: CrudOptions) => (_req: Request, res: Response, id: string) =>
  getRecordById(res, options.table, id, options.select);

export const getCrudBySlug = (options: CrudOptions) => (_req: Request, res: Response, slug: string) =>
  getRecordBySlug(res, options.table, slug, options.select);

export const createCrud = (options: CrudOptions) => (req: Request, res: Response) =>
  createRecord(req, res, options.table, req.body, {
    slugSource: options.slugSource,
    userFields: options.userFields
  });

export const updateCrud = (options: CrudOptions) => (req: Request, res: Response, id: string) =>
  updateRecord(req, res, options.table, id, req.body, {
    slugSource: options.slugSource,
    userFields: options.userFields
  });

export const deleteCrud = (options: CrudOptions) => (req: Request, res: Response, id: string) => {
  if (options.softDelete === false) return deleteRecord(res, options.table, id, req);
  return softDeleteRecord(res, options.table, id, req);
};
