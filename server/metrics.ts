// Fixed daily aggregates only. Never accept request content or identifying fields.
export class Metrics {
 constructor(private storage:DurableObjectStorage){
  storage.sql.exec('CREATE TABLE IF NOT EXISTS aqua_daily (day TEXT PRIMARY KEY, ok INTEGER NOT NULL, denied INTEGER NOT NULL, failed INTEGER NOT NULL, ws_rejected INTEGER NOT NULL)');
 }
 record(status:number,wsRejected=false){
  const day=new Date().toISOString().slice(0,10);
  // Persist immediately: cold eviction can discard in-memory counters before the alarm.
  // Metrics are best effort; failure to record a counter must not change a saved operation.
  try{this.storage.sql.exec('INSERT INTO aqua_daily(day,ok,denied,failed,ws_rejected) VALUES(?,?,?,?,?) ON CONFLICT(day) DO UPDATE SET ok=ok+excluded.ok, denied=denied+excluded.denied, failed=failed+excluded.failed, ws_rejected=ws_rejected+excluded.ws_rejected',day,
   !wsRejected&&status<400?1:0,!wsRejected&&status>=400&&status<500?1:0,!wsRejected&&status>=500?1:0,wsRejected?1:0);
  }catch{}
 }
 flush(){this.storage.sql.exec('DELETE FROM aqua_daily WHERE day < ?',new Date(Date.now()-6*86400_000).toISOString().slice(0,10));}
}
