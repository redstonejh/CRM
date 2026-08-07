const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

(async () => {
  const tileSource = read("dashboard/app/static/modules/tile-system.js");
  const tileSystem = await import(`data:text/javascript;base64,${Buffer.from(tileSource).toString("base64")}`);
  const parent = tileSystem.createTileObject({
    tile:{ id:"root", key:"root", title:"Root" },
    data:{ domain:"test", unit:"root" },
    children:[],
  });
  const sources = [{ id:"one", value:1 }, { id:"two", value:2 }];
  const reconcile = (records) => tileSystem.reconcileTileChildren(parent, records, {
    keyOf:(record) => record.id,
    create:(record, rank) => tileSystem.createTileObject({
      tile:{ id:record.id, key:record.id, title:record.id, rank },
      data:{ record },
      children:[],
    }),
    update:(object, record) => { object.data.record = record; },
  });
  reconcile(sources);
  const firstOne = parent.children[0];
  const firstTwo = parent.children[1];
  reconcile([{ id:"two", value:3 }, { id:"one", value:4 }]);
  assert.equal(parent.children[0], firstTwo, "reordering must preserve the exact child object");
  assert.equal(parent.children[1], firstOne, "refresh must preserve the exact child object");
  assert.equal(parent.children[0].data.record.value, 3, "domain data must update on the owned object");
  assert.equal(tileSystem.indexTileTree(parent).objectForId("one"), firstOne);

  const clients = read("dashboard/app/static/crm-clients.js");
  assert.match(clients, /const rootObject = createTileObject\([\s\S]*?id:"clients"/);
  assert.match(clients, /mountTileChildren\(list, datasetObject/);
  assert.match(clients, /mountTileChildren\(list, report/);
  assert.match(clients, /reconcileDatasetRecords\(datasetObject/);
  assert.doesNotMatch(clients, /state\.datasets|visibleRows|const reportData|records\.map\(rowMarkup\)/);
  assert.doesNotMatch(clients, /\n\s*rootObject\s*=\s*createTileObject/);

  const monitoring = read("dashboard/app/static/crm-monitoring.js");
  assert.match(monitoring, /id:"monitoring"/);
  assert.match(monitoring, /reconcileMonitoringRecords\(liveObject, liveRecords\)/);
  assert.match(monitoring, /mountTileChildren\(list, object/);
  assert.doesNotMatch(monitoring, /let snapshot\s*=|let history\s*=|\.map\(rowMarkup\)/);

  const home = read("dashboard/app/static/crm-home.js");
  assert.match(home, /canonicalModuleObjectFor/);
  assert.match(home, /return canonicalObject/);
  assert.match(home, /JSON\.stringify\(homeTileSnapshots\(homeTileRecords\)\)/);
  assert.doesNotMatch(home, /JSON\.stringify\(homeTileRecords\)/);

  process.stdout.write("canonical object identity smoke test passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
