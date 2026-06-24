import { env } from '../config/env';
import { supabase } from '../config/supabase';

type HubSpotPayload = Record<string, unknown>;

const splitName = (fullName?: unknown) => {
  const parts = String(fullName ?? '').trim().split(/\s+/);
  return {
    firstname: parts[0] ?? '',
    lastname: parts.slice(1).join(' ')
  };
};

const writeSyncLog = async (entityType: string, payload: HubSpotPayload, status: string, response: unknown) => {
  await supabase
    .from('hubspot_sync_logs')
    .insert({
      entity_type: entityType,
      payload,
      provider_response: response,
      status
    });
};

export const syncToHubSpot = async (entityType: 'lead' | 'booking', payload: HubSpotPayload) => {
  if (!env.HUBSPOT_ACCESS_TOKEN) {
    const response = { configured: false, skipped: true };
    await writeSyncLog(entityType, payload, 'skipped', response);
    return response;
  }

  const { firstname, lastname } = splitName(payload.full_name);
  const body = {
    properties: {
      budget_tier: payload.budget_tier,
      country: payload.country,
      email: payload.email,
      firstname,
      hs_lead_status: payload.stage ?? 'New Lead',
      lastname,
      message: payload.message,
      phone: payload.phone,
      travel_destination: payload.destination
    }
  };

  const response = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    method: 'POST'
  });

  const data = await response.json().catch(() => ({}));
  await writeSyncLog(entityType, payload, response.ok ? 'success' : 'failed', data);

  return {
    configured: true,
    ok: response.ok,
    response: data
  };
};

/**
 * Deal-creation scaffold — ready to wire when you want a HubSpot deal per booking
 * request. Intentionally NOT called yet so current behaviour is unchanged. When
 * you turn it on, pass the `CrmLead` (see notification.service) and, ideally, the
 * contact id returned by `syncToHubSpot` so the deal is associated to the contact.
 *
 * Before enabling, in HubSpot create/confirm: a pipeline + a "New Lead" stage,
 * and (optionally) custom deal properties. Replace PIPELINE_ID / STAGE_ID below.
 */
export const createHubSpotDeal = async (lead: {
  bookingCode?: string;
  fullName?: string;
  tripTitle?: string;
  leadSource?: string;
  summary?: string;
}) => {
  if (!env.HUBSPOT_ACCESS_TOKEN) {
    const response = { configured: false, skipped: true };
    await writeSyncLog('deal', lead, 'skipped', response);
    return response;
  }

  const body = {
    properties: {
      dealname: `${lead.tripTitle || 'Trip request'} — ${lead.fullName || lead.bookingCode || ''}`.trim(),
      // pipeline: 'PIPELINE_ID',     // ← set your pipeline id
      // dealstage: 'STAGE_ID',       // ← set the "New Lead" stage id
      lead_source: lead.leadSource ?? 'Website Booking Request',
      description: lead.summary ?? ''
    }
    // associations: [{ to: { id: contactId }, types: [...] }]  // ← associate to contact
  };

  const response = await fetch('https://api.hubapi.com/crm/v3/objects/deals', {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    method: 'POST'
  });

  const data = await response.json().catch(() => ({}));
  await writeSyncLog('deal', lead, response.ok ? 'success' : 'failed', data);
  return { configured: true, ok: response.ok, response: data };
};
