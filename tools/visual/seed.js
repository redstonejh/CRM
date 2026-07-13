// seed.js — the Rosa dataset.
//
// A small, deliberately shaped book of business: companies, contacts (one of
// them 24 days stale so the cold front is visible), deals across
// lead/proposal/won, bills and invoices across their separate lifecycles, tasks for today
// and +2 days, a fully occupied ticket board, calendar items, and interactions. Dates are
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
    { id: 'co_northstar', name: 'Northstar Foods', title: 'Northstar Foods', industry: 'Food distribution', city: 'Olympia' },
    { id: 'co_aldercreek', name: 'Alder Creek Health', title: 'Alder Creek Health', industry: 'Healthcare', city: 'Bellevue' },
    { id: 'co_cascade', name: 'Cascade Fieldworks', title: 'Cascade Fieldworks', industry: 'Environmental services', city: 'Bend' },
    { id: 'co_meridian', name: 'Meridian Fabrication', title: 'Meridian Fabrication', industry: 'Manufacturing', city: 'Kent' },
    { id: 'co_solace', name: 'Solace Property Group', title: 'Solace Property Group', industry: 'Property management', city: 'Spokane' },
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
    {
      id: 'ct_lena', name: 'Lena Ortiz', title: 'Lena Ortiz', client: 'Lena Ortiz',
      company: 'Northstar Foods', companyId: 'co_northstar', role: 'Operations lead',
      stage: 'prospects', state: 'open', priority: 'none',
      lastTouchAt: iso(-5), nextTouchAt: day(3),
      description: 'Coordinating warehouse connectivity across three locations.',
    },
    {
      id: 'ct_priya', name: 'Priya Nair', title: 'Priya Nair', client: 'Priya Nair',
      company: 'Alder Creek Health', companyId: 'co_aldercreek', role: 'Practice administrator',
      stage: 'customers', state: 'open', priority: 'none',
      lastTouchAt: iso(-1),
      description: 'Owns scheduling systems and compliance coordination.',
    },
    {
      id: 'ct_jonah', name: 'Jonah Brooks', title: 'Jonah Brooks', client: 'Jonah Brooks',
      company: 'Cascade Fieldworks', companyId: 'co_cascade', role: 'Field programs director',
      stage: 'partners', state: 'open', priority: 'none',
      lastTouchAt: iso(-8), nextTouchAt: day(5),
      description: 'Needs reliable field sync for remote survey crews.',
    },
    {
      id: 'ct_naomi', name: 'Naomi Ellis', title: 'Naomi Ellis', client: 'Naomi Ellis',
      company: 'Meridian Fabrication', companyId: 'co_meridian', role: 'Plant operations manager',
      stage: 'prospects', state: 'open', priority: 'none',
      lastTouchAt: iso(-4), nextTouchAt: day(4),
      description: 'Coordinating the production-floor systems refresh.',
    },
    {
      id: 'ct_owen', name: 'Owen Mercer', title: 'Owen Mercer', client: 'Owen Mercer',
      company: 'Solace Property Group', companyId: 'co_solace', role: 'Portfolio director',
      stage: 'prospects', state: 'open', priority: 'none',
      lastTouchAt: iso(-7), nextTouchAt: day(6),
      description: 'Standardizing tenant-service systems across the portfolio.',
    },
  ];
  // Keep every company visibly substantial: ten real card records per bucket.
  // Existing named contacts remain canonical; deterministic supporting contacts
  // fill each company to ten without copying card markup or inventing a second
  // People representation.
  const supportingFirstNames = [
    'Avery', 'Maya', 'Theo', 'Nina', 'Elias', 'Cora', 'Julian', 'Zoe', 'Miles', 'Leah',
    'Caleb', 'Amara', 'Finn', 'Elena', 'Rowan', 'Sofia', 'Micah', 'Talia', 'Nolan', 'Maeve',
  ];
  const supportingLastNames = ['Stone', 'Bennett', 'Navarro', 'Whitaker'];
  const supportingRoles = [
    'Account lead', 'Operations manager', 'Finance manager', 'IT administrator', 'Project coordinator',
    'Office manager', 'Service director', 'Procurement lead', 'Program manager', 'Executive sponsor',
  ];
  companies.forEach((company, companyIndex) => {
    const existing = contacts.filter((contact) => contact.companyId === company.id).length;
    for (let slot = existing; slot < 10; slot += 1) {
      const serial = companyIndex * 10 + slot;
      const name = `${supportingFirstNames[serial % supportingFirstNames.length]} ${supportingLastNames[Math.floor(serial / supportingFirstNames.length)]}`;
      contacts.push({
        id: `ct_${company.id.replace(/^co_/, '')}_${slot + 1}`,
        name, title: name, client: name,
        company: company.name, companyId: company.id,
        role: supportingRoles[(slot + companyIndex) % supportingRoles.length],
        stage: 'customers', state: 'open', priority: 'none',
        lastTouchAt: iso(-(2 + (serial % 18))),
        ...(slot % 3 === 0 ? { nextTouchAt: day(4 + (slot % 5)) } : {}),
        description: `Supports ${company.name}'s active account work and coordination.`,
      });
    }
  });
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
      // Every stage complete → the deal has EARNED the Won drop (the F6 motion
      // check drags it onto the Won pile and records the flight + pulse).
      nextStep: 'Send the signed retainer for countersignature.',
      risk: 'Budget review could slip to August.',
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
  const bills = [
    {
      id: 'bill_net_0718', vendor: 'Northstar Fiber', reference: 'ACCT-48391',
      state: 'upcoming', stage: 'upcoming', priority: 'upcoming', amount: 428.16,
      dueDate: day(18), category: 'Internet', owner: 'rosa',
      description: 'Primary office fiber and static IP service.',
    },
    {
      id: 'bill_cloud_0722', vendor: 'Nimbus Cloud', reference: 'NC-2026-07',
      state: 'upcoming', stage: 'upcoming', priority: 'upcoming', amount: 1186.42,
      dueDate: day(22), category: 'Cloud hosting', owner: 'rosa',
      description: 'Production compute, storage, and managed backups.',
    },
    {
      id: 'bill_insurance_0728', vendor: 'Juniper Mutual', reference: 'POL-88210',
      state: 'upcoming', stage: 'upcoming', priority: 'upcoming', amount: 764.00,
      dueDate: day(28), category: 'Insurance', owner: 'rosa',
      description: 'Monthly professional and general liability premium.',
    },
    {
      id: 'bill_power_0702', vendor: 'City Electric', reference: 'ELEC-55018',
      state: 'due', stage: 'due', priority: 'due', amount: 612.73,
      dueDate: day(2), category: 'Utilities', owner: 'rosa',
      description: 'Office and workshop electric service.',
    },
    {
      id: 'bill_mobile_0704', vendor: 'Signal Mobile', reference: 'MOB-19044',
      state: 'due', stage: 'due', priority: 'due', amount: 349.80,
      dueDate: day(4), category: 'Phones', owner: 'rosa',
      description: 'Team mobile lines and field data plans.',
    },
    {
      id: 'bill_software_0706', vendor: 'LedgerWorks', reference: 'LW-7782',
      state: 'due', stage: 'due', priority: 'due', amount: 239.00,
      dueDate: day(6), category: 'Software', owner: 'rosa',
      description: 'Accounting and expense management subscription.',
    },
    {
      id: 'bill_courier_late', vendor: 'Arrow Courier', reference: 'AR-61809',
      state: 'overdue', stage: 'overdue', priority: 'overdue', amount: 184.25,
      dueDate: day(-3), category: 'Shipping', owner: 'rosa',
      nextStep: 'Confirm the disputed after-hours surcharge and release payment.',
      description: 'June parts deliveries and emergency pickup.',
    },
    {
      id: 'bill_lease_late', vendor: 'Crescent Properties', reference: 'SUITE-204',
      state: 'overdue', stage: 'overdue', priority: 'overdue', amount: 2850.00,
      dueDate: day(-8), category: 'Rent', owner: 'rosa',
      nextStep: 'Send payment confirmation to property management.',
      description: 'Monthly office and workshop lease.',
    },
    {
      id: 'bill_security_paid', vendor: 'Sentinel Alarm', reference: 'SA-22017',
      state: 'paid', stage: 'paid', priority: 'paid', amount: 196.00,
      dueDate: day(-12), paidAt: iso(-14), category: 'Security', owner: 'rosa',
      description: 'Monitoring and access-control service.',
    },
    {
      id: 'bill_cleaning_paid', vendor: 'Brightline Facilities', reference: 'BF-2091',
      state: 'paid', stage: 'paid', priority: 'paid', amount: 325.00,
      dueDate: day(-17), paidAt: iso(-18), category: 'Facilities', owner: 'rosa',
      description: 'June office cleaning service.',
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
  // Populate every native ticket destination with real ticket records. The
  // board engine consumes `initialStage` only once; subsequent user movement
  // remains local and authoritative, exactly like every manually placed card.
  const ticketAccounts = companies.map((company) => ({
    id: company.id,
    label: company.name,
    domain: `${company.id.replace(/^co_/, '')}.local`,
  }));
  const ticketLanes = {
    inbox: [
      ['mfa', 'MFA enrollment blocked', 'A new phone cannot complete authenticator enrollment.'],
      ['printer', 'Dispatch printer offline', 'The shared dispatch queue stopped accepting jobs.'],
      ['mailbox', 'Shared mailbox permissions', 'The finance team lost access after a role change.'],
      ['backup', 'Backup job warning', 'The overnight backup completed with skipped files.'],
      ['workstation', 'New starter workstation', 'A new hire needs their workstation and accounts prepared.'],
      ['portal', 'Client portal login failure', 'Several users report rejected portal credentials.'],
    ],
    triage: [
      ['wifi', 'Intermittent Wi-Fi drops', 'Warehouse handhelds disconnect near the loading bays.'],
      ['export', 'Accounting export failing', 'The weekly accounting export exits without a file.'],
      ['vpn', 'VPN disconnects', 'Remote staff lose the tunnel during long sessions.'],
      ['audio', 'Conference room audio', 'The main room microphone is not detected.'],
      ['storage', 'Storage threshold alert', 'Primary document storage crossed the warning threshold.'],
      ['scanner', 'Document scanner unavailable', 'The front office scanner disappeared from the network.'],
    ],
    investigation: [
      ['database', 'Database latency spikes', 'Order entry pauses during short database latency spikes.'],
      ['sso', 'SSO redirect loop', 'Browser sign-in loops between the identity provider and app.'],
      ['sync', 'Nightly sync incomplete', 'The inventory sync leaves a subset of records behind.'],
      ['firewall', 'Firewall rule regression', 'A recent rule publish blocked a vendor endpoint.'],
      ['voip', 'VoIP calls clipping', 'Outbound calls intermittently lose audio packets.'],
      ['agent', 'Monitoring agent stale', 'Several endpoints stopped reporting current status.'],
    ],
    resolution: [
      ['patch', 'Patch validation pending', 'The fix is deployed and awaiting user confirmation.'],
      ['hotfix', 'Vendor hotfix staged', 'A vendor build is installed in the validation ring.'],
      ['dns', 'DNS cutover ready', 'The corrected records are staged for final cutover.'],
      ['switch', 'Replacement switch configured', 'The replacement is configured and ready to install.'],
      ['policy', 'Access policy corrected', 'The corrected policy is live for the affected group.'],
      ['restore', 'Restore verification', 'Recovered files are ready for the owner to verify.'],
    ],
    resolved: [
      ['certificate', 'Certificate renewed', 'The renewed certificate is live and validated.'],
      ['encryption', 'Laptop encryption restored', 'Encryption completed and recovery keys were escrowed.'],
      ['spam', 'Spam rule corrected', 'Mail flow is normal after the transport rule correction.'],
      ['camera', 'Camera feed recovered', 'The recorder and remote viewing feed are healthy again.'],
      ['permissions', 'File share permissions repaired', 'Access was confirmed with the affected team.'],
      ['battery', 'UPS battery replaced', 'The replacement battery passed its self-test.'],
    ],
  };
  const severities = ['medium', 'high', 'low', 'critical'];
  Object.entries(ticketLanes).forEach(([lane, scenarios], laneIndex) => {
    scenarios.forEach(([service, title, description], index) => {
      const account = ticketAccounts[(laneIndex * 2 + index) % ticketAccounts.length];
      const severity = severities[(laneIndex + index) % severities.length];
      const resolved = lane === 'resolved';
      const staged = ['triage', 'investigation', 'resolution'].includes(lane);
      tickets.push({
        id: `tkt_demo_${lane}_${index + 1}`,
        title,
        companyLabel: account.label,
        client: account.label,
        companyId: account.id,
        host: `${service}.${account.domain}`,
        severity,
        priority: severity,
        state: resolved ? 'resolved' : (lane === 'investigation' || lane === 'resolution' ? 'claimed' : 'open'),
        assignee: staged ? 'rosa' : null,
        assignedBy: staged ? 'dispatch' : null,
        claimedBy: lane === 'investigation' || lane === 'resolution' ? 'rosa' : null,
        ...(staged ? { initialStage: lane } : {}),
        ...(lane === 'investigation' || lane === 'resolution' ? {
          investigation: 'Issue reproduced and the affected path isolated.',
          fix: 'Corrective change applied in the validation environment.',
        } : {}),
        ...(lane === 'resolution' || resolved ? {
          resolution: resolved ? 'Client confirmed normal operation.' : 'Validation checks pass; awaiting final confirmation.',
          resolutionDate: day(resolved ? -(1 + index) : 0),
          duration: `${1 + (index % 4)} hours`,
          overtime: 'none',
        } : {}),
        ...(resolved ? { resolvedBy: 'rosa', resolvedAt: iso(-(1 + index), 16) } : {}),
        incidentDate: day(-(1 + laneIndex * 2 + index)),
        createdAt: iso(-(1 + laneIndex * 2 + index), 9 + (index % 7)),
        description,
      });
    });
  });
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
  return { companies, contacts, deals, bills, invoices, tasks, tickets, calendarItems, interactions };
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
  const order = ['companies', 'contacts', 'deals', 'bills', 'invoices', 'tasks', 'tickets', 'calendarItems', 'interactions'];
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
