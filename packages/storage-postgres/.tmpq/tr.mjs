import pg from 'pg';
const c=new pg.Client({host:'127.0.0.1',port:5432,database:'synth',user:'synth',password:process.argv[2]});
await c.connect();
const t=await c.query(`select metadata->'tool_results' tr from messages where session_id='mvw5f7yn-4-wbxq0txf' and ord=57`);
for(const e of t.rows[0].tr||[]){console.log('---',e.name,e.id); console.log('args',JSON.stringify(e.args).slice(0,120)); console.log('meta',JSON.stringify(e.result?.metadata).slice(0,500));}
await c.end();
