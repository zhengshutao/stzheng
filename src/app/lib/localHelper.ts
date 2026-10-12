// 本地 helper(scripts/wealthsimple/helper-server.mjs,http://127.0.0.1:8899)的调用封装。
// 它跑在用户自己的电脑上:打开 Wealthsimple 下载 CSV → 导入 → 同步收盘价 → 写 import_logs。
// 部署在线上的页面也能调它(只要本机在跑 npm run ws:helper)。

export const HELPER_URL = "http://127.0.0.1:8899";

export interface HelperRun {
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  output: string[];
}

export interface HelperStatus {
  ok: boolean;
  running: boolean;
  lastRun: (HelperRun & { canApply?: boolean }) | null;
  prices?: { running: boolean; lastRun: HelperRun | null };
}

export async function helperStatus(): Promise<HelperStatus> {
  const resp = await fetch(`${HELPER_URL}/status`);
  return (await resp.json()) as HelperStatus;
}

export async function startWealthsimpleSync(userId: string | undefined): Promise<{ ok: boolean; running: boolean; canApply?: boolean; message?: string; error?: string }> {
  const resp = await fetch(`${HELPER_URL}/wealthsimple/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  const result = await resp.json().catch(() => ({}));
  if (!resp.ok || result?.ok === false) throw new Error(result?.error ?? "local helper failed");
  return result;
}

export async function startPriceSync(userId: string | undefined, refetch: string[] = []): Promise<{ ok: boolean; running: boolean; message?: string }> {
  const resp = await fetch(`${HELPER_URL}/prices/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, refetch }),
  });
  const result = await resp.json().catch(() => ({}));
  if (!resp.ok || result?.ok === false) throw new Error(result?.error ?? "local helper failed");
  return result;
}

/** 轮询直到某个任务结束(最多 maxSeconds),返回最后一次 status。 */
export async function waitForHelper(pick: (s: HelperStatus) => boolean, maxSeconds = 180): Promise<HelperStatus | null> {
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await helperStatus();
    if (!pick(status)) return status;
  }
  return null;
}
