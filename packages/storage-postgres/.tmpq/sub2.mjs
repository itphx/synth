import pg from 'pg';
const c=new pg.Client({host:'127.0.0.1',port:5432,database:'synth',user:'synth',password:process.argv[2]});
await c.connect();
const t=await c.query(`select ord,role,step_index,metadata,left(content,80) c from messages where session_id='mvw5f7yn-4-wbxq0txf' order by ord`);
for(const r of t.rows){const m=r.metadata||{};const tr=m.tool_results; if(tr) console.log('ord',r.ord,r.role,'step',r.step_index,'tools',JSON.stringify(tr).slice(0,600));}
await c.end();
