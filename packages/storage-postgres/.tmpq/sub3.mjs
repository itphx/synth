import pg from 'pg';
const c=new pg.Client({host:'127.0.0.1',port:5432,database:'synth',user:'synth',password:process.argv[2]});
await c.connect();
const t=await c.query(`select ord,role,step_index,left(content,120) c,metadata from messages where session_id='mvw5f7yn-4-wbxq0txf' and ord>=55 order by ord`);
for(const r of t.rows){const m=r.metadata||{}; console.log('ord',r.ord,r.role,'step',r.step_index,'|',JSON.stringify(r.c)); if(m.tool_results) console.log('  TR',JSON.stringify(m.tool_results).slice(0,500)); if(m.tool_name) console.log('  toolmeta',JSON.stringify(m).slice(0,300));}
await c.end();
