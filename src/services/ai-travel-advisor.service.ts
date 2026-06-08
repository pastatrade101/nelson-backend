import { randomUUID } from 'crypto';
import type { Request } from 'express';
import { env } from '../config/env';
import { supabase } from '../config/supabase';
import { syncToHubSpot } from './hubspot.service';
import { matchToursForLead } from './tour-matching.service';

type LeadContext = {
  budget_tier?: string;
  destination?: string;
  duration_days?: number;
  email?: string;
  full_name?: string;
  persona_tags?: string[];
  phone?: string;
  travel_timing?: string;
};

const inferContext = (message: string, lead?: LeadContext): LeadContext => {
  const lower = message.toLowerCase();
  const persona_tags = new Set(lead?.persona_tags ?? []);

  if (lower.includes('family') || lower.includes('children')) persona_tags.add('family');
  if (lower.includes('honeymoon') || lower.includes('couple')) persona_tags.add('couples');
  if (lower.includes('luxury')) persona_tags.add('luxury');
  if (lower.includes('kilimanjaro') || lower.includes('trek')) persona_tags.add('adventure');

  const destination = lead?.destination ?? (lower.includes('kenya') ? 'Kenya' : lower.includes('rwanda') ? 'Rwanda' : lower.includes('tanzania') ? 'Tanzania' : undefined);
  const durationMatch = lower.match(/(\d{1,2})\s*(day|days|night|nights)/);

  return {
    ...lead,
    destination,
    duration_days: lead?.duration_days ?? (durationMatch ? Number(durationMatch[1]) : undefined),
    persona_tags: [...persona_tags]
  };
};

const createConversation = async (leadContext: LeadContext) => {
  const fallbackId = randomUUID();
  const { data, error } = await supabase
    .from('ai_conversations')
    .insert({
      channel: 'website',
      lead_context: leadContext,
      status: 'in_progress'
    })
    .select('id')
    .single();

  if (error) return fallbackId;
  return data?.id ?? fallbackId;
};

const saveMessage = async (conversationId: string, role: 'assistant' | 'user', content: string) => {
  await supabase
    .from('ai_messages')
    .insert({ content, conversation_id: conversationId, role });
};

const saveLeadContext = async (conversationId: string, leadContext: LeadContext) => {
  await supabase
    .from('ai_lead_context')
    .upsert({ conversation_id: conversationId, ...leadContext }, { onConflict: 'conversation_id' });
};

const saveMatches = async (conversationId: string, matches: Array<{ score: number; tour: Record<string, unknown> }>) => {
  if (!matches.length) return;

  await supabase
    .from('tour_match_results')
    .insert(
      matches.map((match) => ({
        conversation_id: conversationId,
        match_score: match.score,
        tour_id: match.tour.id
      }))
    );
};

const fallbackReply = (matches: Array<{ score: number; tour: Record<string, unknown> }>) => {
  const tourLine = matches[0]?.tour?.title ? ` A strong starting match is ${String(matches[0].tour.title)}.` : '';
  return `I am the Goldfinch AI Travel Advisor, an AI advisor, not a human agent. I can help narrow East Africa options by destination, timing, duration, budget, and travel style.${tourLine} To improve the match, please share your preferred country, number of days, approximate budget tier, and whether this is family, luxury, adventure, honeymoon, or wildlife-focused.`;
};

const anthropicReply = async (message: string, leadContext: LeadContext, matches: Array<{ score: number; tour: Record<string, unknown> }>) => {
  if (!env.ANTHROPIC_API_KEY) return fallbackReply(matches);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    body: JSON.stringify({
      max_tokens: 700,
      messages: [
        {
          content: `Traveler message: ${message}\nLead context: ${JSON.stringify(leadContext)}\nTour matches: ${JSON.stringify(matches)}`,
          role: 'user'
        }
      ],
      model: 'claude-3-5-sonnet-latest',
      system:
        'You are Goldfinch AI Travel Advisor. Always identify as an AI advisor and never claim to be human. Be warm, honest, local, specific, and confidence-building. Ask about destination, duration, timing, budget, and traveler persona. Recommend CMS tours only when matches are provided. Keep the response concise.',
      temperature: 0.4
    }),
    headers: {
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY
    },
    method: 'POST'
  });

  const data = await response.json().catch(() => null);
  const content = Array.isArray(data?.content) ? data.content.map((item: { text?: string }) => item.text).filter(Boolean).join('\n') : '';
  return content || fallbackReply(matches);
};

export const handleAdvisorChat = async (body: { conversationId?: string; lead?: LeadContext; message: string }) => {
  const leadContext = inferContext(body.message, body.lead);
  const conversationId = body.conversationId ?? (await createConversation(leadContext));
  const matches = await matchToursForLead(leadContext);
  const reply = await anthropicReply(body.message, leadContext, matches);

  await saveMessage(conversationId, 'user', body.message);
  await saveMessage(conversationId, 'assistant', reply);
  await saveLeadContext(conversationId, leadContext);
  await saveMatches(conversationId, matches);

  return {
    conversationId,
    reply,
    tourMatches: matches
  };
};

export const handoffConversation = async (conversationId: string, req: Request, notes?: string) => {
  const { data: context } = await supabase.from('ai_lead_context').select('*').eq('conversation_id', conversationId).maybeSingle();
  const hubspot = context?.email ? await syncToHubSpot('lead', { ...context, message: notes, source: 'Goldfinch AI Travel Advisor' }) : { configured: false, skipped: true };

  await supabase
    .from('ai_conversations')
    .update({ handoff_at: new Date().toISOString(), handoff_by: req.user?.sub, status: 'handoff_ready' })
    .eq('id', conversationId);

  return {
    conversationId,
    hubspot
  };
};
