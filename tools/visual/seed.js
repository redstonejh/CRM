// seed.js — the Rosa dataset.
//
// A small, deliberately shaped book of business: companies, contacts (one of
// them 24 days stale so the cold front is visible), deals across
// lead/proposal/won, invoices across draft/sent-overdue/paid, tasks for today
// and +2 days, one ticket, calendar items, and logged interactions. Dates are
// relative to "now" so the Today hand, aging buckets and staleness always
// exercise the same code paths regardless of the wall clock.
'use strict';

const DAY = 86400000;

function iso(daysFromNow, hour = 10) {
  const d = new Date(Date.now() + daysFromNow * DAY);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}
function day(daysFromNow) {
  return new Date(Date.now() + daysFromNow * DAY).toISOString().slice(0, 10);
}

function rosaDataset() {
  const companies = [
    { id: 'co_harborlane', name: 'Harbor & Lane', title: 'Harbor & Lane', industry: 'Architecture', city: 'Portland' },
    { id: 'co_bluepeak', name: 'Bluepeak Logistics', title: 'Bluepeak Logistics', industry: 'Freight', city: 'Tacoma' },
    { id: 'co_foxglove', name: 'Foxglove Studio', title: 'Foxglove Studio', industry: 'Design', city: 'Seattle' },
  ];
  const contacts = [
    {
      id: 'ct_marta', name: 'Marta Reyes', title: 'Marta Reyes', client: 'Marta Reyes',
      company: 'Harbor & Lane', companyId: 'co_harborlane', role: 'Managing partner',
      stage: 'customers', state: 'open', priority: 'none',
      lastTouchAt: iso(-3), nextTouchAt: day(0),
      description: 'Owns the retainer decision. Prefers calls over email.',
    },
    {
      id: 'ct_devon', name: 'Devon Park', title: 'Devon Park', client: 'Devon Park',
      company: 'Bluepeak Logistics', companyId: 'co_bluepeak', role: 'Ops director',
      stage: 'prospects', state: 'open', priority: 'none',
      // The cold-front contact: 24 days since the last touch (half-life 21).
      lastTouchAt: iso(-24),
      description: 'Evaluating the onboarding pilot. Slow to respond.',
    },
    {
      id: 'ct_iris', name: 'Iris Chen', title: 'Iris Chen', client: 'Iris Chen',
      company: 'Foxglove Studio', companyId: 'co_foxglove', role: 'Founder',
      stage: 'customers', state: 'open', priority: 'none',
      lastTouchAt: iso(-2),
      description: 'Rebrand shipped; good reference customer.',
    },
    {
      id: 'ct_sam', name: 'Sam Okafor', title: 'Sam Okafor', client: 'Sam Okafor',
      company: 'Bluepeak Logistics', companyId: 'co_bluepeak', role: 'IT manager',
      stage: 'vendors', state: 'open', priority: 'none',
      lastTouchAt: iso(-6),
      description: 'Day-to-day technical contact for the mail migration.',
    },
  ];
  const deals = [
    {
      id: 'dl_bluepeak_onboarding', title: 'Bluepeak onboarding pilot', client: 'Bluepeak Logistics',
      companyId: 'co_bluepeak', stage: 'lead', state: 'open', priority: 'warm',
      amount: 8400, owner: 'rosa', lastTouchAt: iso(-4),
      description: '90-day managed onboarding pilot for the Tacoma depot.',
      incidentDate: day(-12),
    },
    {
      id: 'dl_harborlane_retainer', title: 'Harbor & Lane retainer', client: 'Harbor & Lane',
      companyId: 'co_harborlane', stage: 'proposal', state: 'open', priority: 'hot',
      amount: 24000, owner: 'rosa', lastTouchAt: iso(-1), nextTouchAt: day(0),
      decisionMaker: 'Marta Reyes', pain: 'In-house IT retired; need coverage by Q4.',
      budget: '20-30k / yr', proposal: 'Annual retainer, 12 seats, on-site quarterly.',
      closeDate: day(9),
      description: 'Annual managed-services retainer.',
      incidentDate: day(-30),
    },
    {
      id: 'dl_foxglove_rebrand', title: 'Foxglove rebrand infra', client: 'Foxglove Studio',
      companyId: 'co_foxglove', stage: 'won', state: 'won', priority: 'commit',
      amount: 12500, owner: 'rosa', wonAt: iso(-7), lastTouchAt: iso(-7),
      description: 'Workstation refresh + NAS for the rebranded studio.',
      incidentDate: day(-45),
    },
  ];
  const invoices = [
    {
      id: 'inv_1042', number: 'INV-1042', title: 'INV-1042 — Bluepeak pilot deposit', client: 'INV-1042',
      companyId: 'co_bluepeak', dealId: 'dl_bluepeak_onboarding',
      state: 'draft', stage: 'draft', priority: 'draft', amount: 3800,
      dueDate: day(14), description: 'Deposit for the onboarding pilot.',
    },
    {
      id: 'inv_1038', number: 'INV-1038', title: 'INV-1038 — Harbor & Lane audit', client: 'INV-1038',
      companyId: 'co_harborlane',
      state: 'sent', stage: 'sent', priority: 'sent', amount: 9200,
      sentAt: iso(-16), dueDate: day(-9), lastTouchAt: iso(-16),
      description: 'Network audit engagement. Sent, now past due.',
    },
    {
      id: 'inv_1031', number: 'INV-1031', title: 'INV-1031 — Foxglove rebrand', client: 'INV-1031',
      companyId: 'co_foxglove', dealId: 'dl_foxglove_rebrand',
      state: 'paid', priority: 'paid', amount: 12500,
      sentAt: iso(-20), dueDate: day(-6), paidAt: iso(-8),
      description: 'Workstation refresh + NAS. Paid in full.',
    },
  ];
  const tasks = [
    {
      id: 'tk_call_marta', title: 'Call Marta about the retainer', client: 'Call Marta about the retainer',
      state: 'open', dueDate: day(0), assignee: 'rosa', companyId: 'co_harborlane',
      description: 'Walk through the proposal before Thursday.',
    },
    {
      id: 'tk_prep_deck', title: 'Prep Bluepeak pilot deck', client: 'Prep Bluepeak pilot deck',
      state: 'open', dueDate: day(2), assignee: 'rosa', companyId: 'co_bluepeak',
      description: 'Two slides: scope and the 90-day timeline.',
    },
  ];
  const tickets = [
    {
      id: 'tkt_bluepeak_mail', companyLabel: 'Bluepeak Logistics', client: 'Bluepeak Logistics',
      host: 'mail01.bluepeak.local', severity: 'high', priority: 'high', state: 'open',
      assignee: null, assignedBy: null, claimedBy: null,
      incidentDate: day(-1), description: 'Outbound mail queue backing up since the weekend.',
    },
  ];
  const calendarItems = [
    { id: 'cal_marta_call', title: 'Marta — retainer call', date: day(0), at: iso(0, 14), kind: 'call', companyId: 'co_harborlane' },
    { id: 'cal_bluepeak_visit', title: 'Bluepeak depot walkthrough', date: day(2), at: iso(2, 9), kind: 'visit', companyId: 'co_bluepeak' },
  ];
  const interactions = [
    {
      id: 'ix_marta_call', kind: 'call', at: iso(-1, 15),
      note: 'Marta reviewed the proposal; wants the on-site quarterly language firmed up.',
      contactId: 'ct_marta', dealId: 'dl_harborlane_retainer', companyId: 'co_harborlane',
    },
    {
      id: 'ix_iris_note', kind: 'note', at: iso(-2, 11),
      note: 'Iris happy with the NAS throughput. Ask for a reference in August.',
      contactId: 'ct_iris', companyId: 'co_foxglove',
    },
  ];
  return { companies, contacts, deals, invoices, tasks, tickets, calendarItems, interactions };
}

async function post(apiUrl, entity, fields) {
  const res = await fetch(`${apiUrl}/api/entities/${entity}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields, actor: 'rosa', options: { detail: `Seeded ${entity}` } }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Seeding ${entity}/${fields.id} failed: ${json.error}`);
  return json.record;
}

// Interactions fan lastTouchAt onto their related records, so seed them LAST —
// and seed base entities before anything that references them.
async function seed(apiUrl = 'http://127.0.0.1:3899') {
  const data = rosaDataset();
  const order = ['companies', 'contacts', 'deals', 'invoices', 'tasks', 'tickets', 'calendarItems', 'interactions'];
  const counts = {};
  for (const entity of order) {
    for (const fields of data[entity]) await post(apiUrl, entity, fields);
    counts[entity] = data[entity].length;
  }
  return counts;
}

module.exports = { seed, rosaDataset };

if (require.main === module) {
  seed(process.env.CRM_API_URL || 'http://127.0.0.1:3899')
    .then((counts) => { console.log('[seed] done', counts); })
    .catch((err) => { console.error('[seed] failed:', err.message); process.exit(1); });
}
