import pg from 'pg';
const c=new pg.Client({host:'127.0.0.1',port:5432,database:'synth',user:'synth',password:process.argv[2]});
await c.connect();
const t=await c.query(`select session_id, ord, role, ord, metadata->>'type' typ, metadata->'tool_results' tr, content from messages where created_at > now() - interval '3 hours' and role='assistant' order by created_at desc limit 40`);
for(const r of t.rows){
 const tr=r.tr;
 if(tr && JSON.stringify(tr).includes('subagent_type')) console.log('S',r.session_id.slice(0,8),'ord',r.ord,'typ',r.typ,'trlen',JSON.stringify(tr).length, JSON.stringify(tr).slice(0,300));
}
await c.end();
