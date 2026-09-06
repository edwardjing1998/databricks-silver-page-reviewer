let tokenCache = { token: "", expiresAt: 0 };

async function oauthToken(c) {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.token;
  const body = new URLSearchParams({ grant_type: "client_credentials", scope: "all-apis" });
  const basic = Buffer.from(`${process.env.DATABRICKS_CLIENT_ID}:${process.env.DATABRICKS_CLIENT_SECRET}`).toString("base64");
  const response = await fetch(`${c.databricksHost}/oidc/v1/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new Error(`Databricks OAuth failed (${response.status}): ${await response.text()}`);
  const data = await response.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

function rows(result) {
  const columns = result.manifest?.schema?.columns?.map(column => column.name) || [];
  return (result.result?.data_array || []).map(values => Object.fromEntries(columns.map((name, i) => [name, values[i]])));
}

async function call(c, path, init = {}) {
  const token = await oauthToken(c);
  const response = await fetch(`${c.databricksHost}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `Databricks request failed: ${response.status}`);
  return body;
}

export async function execute(c, statement, parameters = []) {
  let result = await call(c, "/api/2.0/sql/statements", {
    method: "POST",
    body: JSON.stringify({
      warehouse_id: c.warehouseId,
      statement,
      parameters,
      wait_timeout: "30s",
      on_wait_timeout: "CONTINUE",
      disposition: "INLINE",
      format: "JSON_ARRAY"
    })
  });
  while (["PENDING", "RUNNING"].includes(result.status?.state)) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    result = await call(c, `/api/2.0/sql/statements/${result.statement_id}`);
  }
  if (result.status?.state !== "SUCCEEDED") {
    throw new Error(result.status?.error?.message || `SQL statement ended in ${result.status?.state}`);
  }
  return rows(result);
}

export const parameter = (name, value, type = "STRING") => ({ name, value: String(value), type });
