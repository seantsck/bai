import pg from 'pg'
const [db, ...sql] = process.argv.slice(2)
const c = new pg.Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:54329/${db}` }); await c.connect()
const r = await c.query(sql.join(' ')); console.log(JSON.stringify(r.rows, null, 0).slice(0, 6000)); await c.end()
