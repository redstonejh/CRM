// Declarative projection of the unchanged CDMS API into the CRM object system.
// Backend workbook names and natural-key identifiers live here so rooms do not
// grow their own incompatible request or mutation logic.
export const CDMS_ROOMS = [
  { key:"overview", label:"Overview" },
  { key:"infrastructure", label:"Infrastructure" },
  { key:"people", label:"People & Accounts" },
  { key:"access", label:"Services & Access" },
  { key:"sites", label:"Sites & Domains" },
  { key:"reports", label:"Reports" },
  { key:"misc", label:"Misc" },
  { key:"work", label:"Work" },
  { key:"monitoring", label:"Monitoring" },
];

const dataset = (definition) => Object.freeze({
  clientField:"Client",
  identifiers:["Client"],
  titleFields:["Name", "Service", "Computer Name", "Email", "IP address", "IP Address"],
  subtitleFields:["Description", "Location", "SubName", "Host / URL", "Username", "Login"],
  archiveColumn:"Inactive",
  editable:true,
  addable:true,
  exportable:true,
  ...definition,
});

export const CDMS_DATASETS = Object.freeze([
  dataset({
    key:"core", label:"Core infrastructure", room:"infrastructure", endpoint:"core", fileKey:"core",
    identifiers:["Client", "Name", "IP address"], titleFields:["Name", "IP address"],
  }),
  dataset({
    key:"externalInfo", label:"Firewalls & VPN", room:"infrastructure", endpoint:"external-info", fileKey:"externalInfo",
    identifiers:["Client", "SubName", "Device Type"], titleFields:["Device Type", "SubName", "IP address"],
  }),
  dataset({
    key:"workstations", label:"Workstations", room:"infrastructure", endpoint:"workstations", fileKey:"workstations",
    identifiers:["Client", "Computer Name"], titleFields:["Computer Name", "IP Address"],
    archiveColumn:"Active", inactiveValue:0,
  }),
  dataset({
    key:"workstationsUsers", label:"Workstations + users", room:"people", endpoint:"workstations-users",
    identifiers:["_wsClient", "_wsComputerName"], titleFields:["computerName", "userDisplay"],
    editable:false, addable:false,
  }),
  dataset({
    key:"devices", label:"Devices", room:"infrastructure", endpoint:"devices", fileKey:"devices",
    clientField:"client", identifiers:["client", "Name", "IP address"], titleFields:["Name", "IP address"],
  }),
  dataset({
    key:"cameras", label:"Cameras", room:"infrastructure", endpoint:"cameras", fileKey:"cameras",
    identifiers:["Client", "Name", "IP"], titleFields:["Name", "IP", "Host NVR"],
  }),
  dataset({
    key:"vms", label:"Virtual machines", room:"infrastructure", endpoint:"vms", fileKey:"vms",
    identifiers:["Client", "Name", "Host"], titleFields:["Name", "IP", "Host"],
    archiveColumn:"Active", inactiveValue:0,
  }),
  dataset({
    key:"containers", label:"Containers", room:"infrastructure", endpoint:"containers", fileKey:"containers",
    identifiers:["Client", "Name", "Host"], titleFields:["Name", "IP", "Host"],
  }),
  dataset({
    key:"daemons", label:"Daemons", room:"infrastructure", endpoint:"daemons", fileKey:"daemons",
    identifiers:["Client", "Name", "Host"], titleFields:["Name", "IP", "Host"],
  }),
  dataset({
    key:"users", label:"Users", room:"people", endpoint:"users", fileKey:"users",
    identifiers:["Client", "Login"], titleFields:["Name", "Login", "Computer Name"],
    archiveColumn:"Active", inactiveValue:0,
  }),
  dataset({
    key:"emails", label:"Email accounts", room:"people", endpoint:"emails", fileKey:"emails",
    identifiers:["Client", "Email"], titleFields:["Name", "Email", "Username"],
    archiveColumn:"Active", inactiveValue:0,
  }),
  dataset({
    key:"managedInfo", label:"Points of contact", room:"people", endpoint:"managed-info", fileKey:"managedInfo",
    identifiers:["Client", "Provider", "Name"], titleFields:["Provider", "Name", "Email"],
    archiveColumn:"Active", inactiveValue:0,
  }),
  dataset({
    key:"phoneNumbers", label:"Phone numbers", room:"people", endpoint:"phone-numbers", fileKey:"phoneNumbers",
    identifiers:["Client", "Name", "Number"], titleFields:["Name", "Number"],
  }),
  dataset({
    key:"services", label:"Services", room:"access", endpoint:"services", fileKey:"services",
    identifiers:["Client", "Service", "Username"], titleFields:["Service", "Username", "Host / URL"],
  }),
  dataset({
    key:"guacamole", label:"Remote access", room:"access", endpoint:"guacamole", fileKey:"guacamoleHosts",
    identifiers:["Client", "Cloud Name"], titleFields:["Cloud Name", "IP", "Hard Coded IP"],
  }),
  dataset({
    key:"adminEmails", label:"Admin emails", room:"access", endpoint:"admin-credentials", payloadKey:"adminEmails",
    fileKey:"adminEmails", identifiers:["Client", "Email"], titleFields:["Name", "Email"],
  }),
  dataset({
    key:"voipLogins", label:"VOIP logins", room:"access", endpoint:"admin-credentials", payloadKey:"voipLogins",
    fileKey:"adminVoipLogins", identifiers:["Client", "Login"], titleFields:["VOIP Provider", "Login"],
  }),
  dataset({
    key:"acronisBackups", label:"Acronis backups", room:"access", endpoint:"admin-credentials", payloadKey:"acronisBackups",
    fileKey:"acronisBackups", identifiers:["Client", "UserName"], titleFields:["Acronis Cyber Cloud ", "UserName"],
  }),
  dataset({
    key:"cloudflareAdmins", label:"Cloudflare", room:"access", endpoint:"admin-credentials", payloadKey:"cloudflareAdmins",
    fileKey:"cloudflareAdmins", identifiers:["Client", "username"], titleFields:["username"],
  }),
  dataset({
    key:"domains", label:"Domains & Active Directory", room:"sites", endpoint:"domains", fileKey:"domains",
    identifiers:["Client", "Domain Name"], titleFields:["Domain Name", "Alt Domain"],
  }),
  dataset({
    key:"websites", label:"Websites & DNS", room:"sites", endpoint:"websites", fileKey:"websites",
    identifiers:["Client", "URL"], titleFields:["URL", "Registrar", "DNS Host", "Website Host"],
    archiveColumn:"Is Inactive",
  }),
  dataset({
    key:"misc", label:"Miscellaneous", room:"misc", endpoint:"misc", fileKey:"misc",
    identifiers:["_rowIndex"], titleFields:["Notes", "Notes 1", "Notes 2"],
    archiveColumn:null,
  }),
]);

export const CDMS_REPORTS = Object.freeze([
  { key:"inactive", label:"Inactive Assets" },
  { key:"missing", label:"Missing Data" },
  { key:"mfa", label:"MFA Status" },
  { key:"firmware", label:"Firmware Versions" },
  { key:"resources", label:"Host Resources" },
  { key:"password-age", label:"Password Age" },
  { key:"windows-11", label:"Windows 11 Ready" },
  { key:"source-health", label:"Source Health" },
]);

export const datasetByKey = (key) => CDMS_DATASETS.find((item) => item.key === String(key || "")) || null;
export const datasetsForRoom = (room) => CDMS_DATASETS.filter((item) => item.room === String(room || ""));

export const payloadRows = (result, definition) => {
  const payload = result?.payload || result || {};
  if (definition?.payloadKey) return Array.isArray(payload[definition.payloadKey]) ? payload[definition.payloadKey] : [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.records)) return payload.records;
  if (Array.isArray(payload.clients)) return payload.clients;
  return [];
};

export const rowIdentifier = (definition, record = {}) => Object.fromEntries(
  (definition?.identifiers || []).filter((field) => record[field] !== undefined)
    .map((field) => [field, record[field]]),
);

export const recordTitle = (definition, record = {}) => {
  for (const field of definition?.titleFields || []) {
    const value = String(record[field] ?? "").trim();
    if (value) return value;
  }
  return definition?.label || "Record";
};

export const recordSubtitle = (definition, record = {}) => {
  const values = [];
  for (const field of definition?.subtitleFields || []) {
    const value = String(record[field] ?? "").trim();
    if (value && !values.includes(value)) values.push(value);
    if (values.length >= 2) break;
  }
  return values.join(" · ");
};

if (typeof window !== "undefined") {
  window.crmCdmsDatasets = {
    rooms:CDMS_ROOMS,
    datasets:CDMS_DATASETS,
    reports:CDMS_REPORTS,
    byKey:datasetByKey,
    forRoom:datasetsForRoom,
    rows:payloadRows,
    identifier:rowIdentifier,
    title:recordTitle,
    subtitle:recordSubtitle,
  };
}
