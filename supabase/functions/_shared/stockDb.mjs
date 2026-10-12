// Supabase 表读取的小工具(client 由调用方传入:本地脚本是 node 的 supabase-js,edge function 是 jsr 的)。

/** 分页拉全表(PostgREST 单次最多 1000 行)。filters(query) 可以追加 .eq() 之类的条件。 */
export async function fetchAllRows(client, table, columns, filters = (q) => q, orderCols = ["date"]) {
  const all = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let query = client.from(table).select(columns);
    query = filters(query);
    for (const col of orderCols) query = query.order(col, { ascending: true });
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw new Error(`${table} fetch failed: ${error.message}`);
    all.push(...data);
    if (data.length < pageSize) return all;
  }
}

/** 表还没建(schema.sql 没跑)时 PostgREST 的报错。 */
export function isMissingTableError(error) {
  const msg = String(error?.message ?? error ?? "").toLowerCase();
  return msg.includes("schema cache") || msg.includes("does not exist") || msg.includes("could not find the table");
}
