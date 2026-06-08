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
