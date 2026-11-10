import { randomUUID } from 'node:crypto';
import { startOfDay, wallClock } from './temporal.js';
import type { TurnRecord } from '../types.js';

/**
 * Sample history so a first-time user can try "what did I ask on Monday?" on day one.
 * Dates are relative to *now*, so the sample is always realistic. Figures are
 * illustrative fixtures, not a claim about real prices.
 */
type When = { lastWeekday: number; at: string } | { monthDay: [number, number]; at: string };

function resolve(when: When, now: Date, tz: string): Date {
  const t = wallClock(now, tz);
  const [hh, mm] = when.at.split(':').map(Number);
  let y = t.y, m = t.m, d = t.d;
  if ('lastWeekday' in when) {
    const dow = new Date(Date.UTC(t.y, t.m - 1, t.d)).getUTCDay();
    const back = (dow - when.lastWeekday + 7) % 7 || 7;
    const dt = new Date(Date.UTC(t.y, t.m - 1, t.d - back));
    y = dt.getUTCFullYear(); m = dt.getUTCMonth() + 1; d = dt.getUTCDate();
  } else {
    [m, d] = when.monthDay;
    y = t.y;
    if (Date.UTC(y, m - 1, d) > Date.UTC(t.y, t.m - 1, t.d)) y -= 1;
  }
  const base = startOfDay(y, m, d, tz);
  return new Date(base.getTime() + (hh * 60 + mm) * 60_000);
}

export function sampleTurns(now: Date, tz: string): TurnRecord[] {
  const mk = (when: When, user: string, assistant: string, searches: TurnRecord['searches']): TurnRecord => ({
    id: randomUUID().slice(0, 8),
    conversationId: `sample-${when.at}-${'lastWeekday' in when ? when.lastWeekday : when.monthDay.join('-')}`,
    ts: resolve(when, now, tz).toISOString(),
    tz,
    user,
    assistant,
    searches,
  });
  return [
    mk(
      { lastWeekday: 1, at: '10:30' },
      "We're a 20-person sales team picking a CRM. Shortlist these 5 and compare pricing for 20 seats: HubSpot Sales Hub, Pipedrive, Zoho CRM, Close, Salesforce Starter.",
      `Shortlist for 20 seats (list prices, billed annually, approximate):\n\n| Tool | Entry paid tier | ~Per seat/mo | ~20 seats/mo |\n|---|---|---|---|\n| Pipedrive | Essential | $14 | $280 |\n| Zoho CRM | Standard | $14 | $280 |\n| HubSpot Sales Hub | Starter | $20 | $400 |\n| Close | Startup | $29 | $580 |\n| Salesforce | Starter Suite | $25 | $500 |\n\nPipedrive and Zoho are cheapest; HubSpot has the smoothest onboarding for a team your size.`,
      [
        { query: 'HubSpot Sales Hub Starter price per seat', results: [{ title: 'HubSpot Sales Hub pricing', url: 'https://www.hubspot.com/pricing/sales', snippet: 'Starter plan pricing per seat.' }] },
        { query: 'Pipedrive pricing plans per user', results: [{ title: 'Pipedrive pricing', url: 'https://www.pipedrive.com/en/pricing', snippet: 'Essential, Advanced, Professional plans.' }] },
      ],
    ),
    mk(
      { lastWeekday: 2, at: '16:05' },
      'Which managed Postgres should I use for a small SaaS? Compare Neon, Supabase, Render and AWS RDS on price.',
      'For a small SaaS: Neon (free tier, usage-based paid from ~$19/mo) and Supabase (free tier, Pro from $25/mo) are the best value; Render starts around $7/mo for a small instance; RDS is cheapest at scale but has the most operational overhead. I would start on Neon or Supabase.',
      [
        { query: 'Neon Postgres pricing', results: [{ title: 'Neon pricing', url: 'https://neon.com/pricing', snippet: 'Free, Launch and Scale plans.' }] },
        { query: 'Supabase Pro plan price', results: [{ title: 'Supabase pricing', url: 'https://supabase.com/pricing', snippet: 'Free, Pro $25/month.' }] },
      ],
    ),
    mk(
      { monthDay: [11, 3], at: '09:15' },
      'What is the current Node.js LTS release line, and when does it reach end of life?',
      'Node.js 24 is the current Active LTS line, supported until April 2028. Node 22 is in Maintenance LTS. Node 25 is the current non-LTS release.',
      [{ query: 'Node.js release schedule LTS', results: [{ title: 'Node.js Releases', url: 'https://nodejs.org/en/about/previous-releases', snippet: 'Release schedule and LTS status.' }] }],
    ),
  ];
}
