import pg from 'pg';
const c=new pg.Client({host:'127.0.0.1',port:5432,database:'synth',user:'synth',password:process.argv[2]});
await c.connect();
const s=await c.query(`select id,title from sessions where id='mvw5f7yn-4-wbxq0txf'`);
console.log(s.rows);
const t=await c.query(`select ord,role,step_index,debug_data is not null dbg, jsonb_typeof(debug_data) ty, metadata->>'status' st from messages where session_id='mvw5f7yn-4-wbxq0txf' order by ord`);
for(const r of t.rows) console.log(r.ord,r.role,'step',r.step_index,'dbg',r.dbg,r.ty,'st',r.st);
await c.end();
