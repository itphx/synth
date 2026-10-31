import pg from 'pg';
const c=new pg.Client({host:'127.0.0.1',port:5432,database:'synth',user:'synth',password:process.argv[2]});
await c.connect();
const s=await c.query(`select id,title,updated_at from sessions where exists (select 1 from messages m where m.session_id=sessions.id and m.content like '%Протестируем работу обвязки%') order by updated_at desc limit 3`);
for(const r of s.rows) console.log('SESSION',r.id,r.title,r.updated_at.toISOString());
if(s.rows[0]){
 const t=await c.query(`select ord,id,role,step_index,status,metadata->>'tool_chain' tc,left(content,50) c from messages where session_id=$1 order by ord`, [s.rows[0].id]);
 for(const r of t.rows) console.log(r.ord,r.role,'step',r.step_index,'st',r.status,'tc',r.tc,'|',JSON.stringify(r.c));
}
await c.end();
