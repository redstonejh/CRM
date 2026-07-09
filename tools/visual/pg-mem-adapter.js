// pg-mem adapter for the real API server (server/index.js).
//
// The harness runs the actual server code against an in-memory Postgres.
// pg-mem does not parse a few constructs the production schema/queries use
// (GIN indexes, DESC index columns, FOR UPDATE row locks), so the adapter
// rewrites those to equivalents before handing queries to pg-mem. Row locks
// are safe to drop: the harness is single-process and pg-mem serializes
// queries anyway.
'use strict';
const Module = require('node:module');
const { newDb } = require('pg-mem');

function rewriteSql(sql) {
  return String(sql)
    .replace(/CREATE\s+INDEX[^;]*USING\s+gin[^;]*;/gi, '')
    .replace(/updated_at\s+DESC\s*\)/gi, 'updated_at)')
    .replace(/\s+FOR\s+UPDATE\b/gi, '');
}

// Installs an in-memory pg for every subsequent require('pg') in this process.
// Returns the pg-mem database (handy for tests that want to reset state).
function installPgMem() {
  const db = newDb();
  const adapter = db.adapters.createPg();

  class MemPool extends adapter.Pool {
    query(text, params) {
      if (typeof text === 'string') return super.query(rewriteSql(text), params);
      if (text && typeof text.text === 'string') return super.query({ ...text, text: rewriteSql(text.text) }, params);
      return super.query(text, params);
    }
    async connect(...args) {
      const client = await super.connect(...args);
      const rawQuery = client.query.bind(client);
      client.query = (text, params) => {
        if (typeof text === 'string') return rawQuery(rewriteSql(text), params);
        if (text && typeof text.text === 'string') return rawQuery({ ...text, text: rewriteSql(text.text) }, params);
        return rawQuery(text, params);
      };
      return client;
    }
  }

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'pg') return { ...adapter, Pool: MemPool };
    return originalLoad.call(this, request, parent, isMain);
  };
  return db;
}

module.exports = { installPgMem, rewriteSql };
