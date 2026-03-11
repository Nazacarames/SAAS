require('dotenv').config();
const { Client } = require('pg');
(async()=>{
 const cfg=process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL}:{host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||5432),user:process.env.DB_USER,password:process.env.DB_PASS,database:process.env.DB_NAME};
 const c=new Client(cfg); await c.connect();
 const cols=await c.query("select column_name,data_type from information_schema.columns where table_name='meta_connections' order by ordinal_position");
 console.log(cols.rows);
 const row=await c.query('select * from meta_connections order by id desc limit 1');
 console.log(row.rows[0]);
 await c.end();
})();