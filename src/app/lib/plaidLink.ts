// 按需加载 Plaid Link 官方脚本(和 /Users/szheng/记账/public/index.html 用的是同一个 CDN 地址),
// 不放进 index.html 全局引入 —— 这是个人作品集站点,没必要让每个页面都加载 Plaid 的脚本。

const PLAID_SCRIPT_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

interface PlaidLinkMetadata {
  institution: { institution_id: string; name: string } | null;
  link_session_id?: string;
  request_id?: string;
  status?: string;
}

export interface PlaidLinkError {
  error_type?: string;
  error_code?: string;
  error_message?: string;
  display_message?: string | null;
}

interface PlaidLinkHandler {
  open: () => void;
}

interface PlaidGlobal {
  create: (config: {
    token: string;
    onSuccess: (publicToken: string, metadata: PlaidLinkMetadata) => void;
    onExit?: (error: PlaidLinkError | null, metadata: PlaidLinkMetadata) => void;
  }) => PlaidLinkHandler;
}

declare global {
  interface Window {
    Plaid?: PlaidGlobal;
  }
}

let loadPromise: Promise<void> | null = null;

function loadPlaidScript(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  if (!loadPromise) {
    loadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = PLAID_SCRIPT_SRC;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("加载 Plaid Link 脚本失败"));
      document.head.appendChild(script);
    });
  }
  return loadPromise;
}

export async function openPlaidLink(
  token: string,
  onSuccess: (publicToken: string, institution: { institution_id?: string; name?: string } | null) => void,
  onExit?: (error: PlaidLinkError | null, metadata: PlaidLinkMetadata) => void
): Promise<void> {
  await loadPlaidScript();
  if (!window.Plaid) throw new Error("Plaid Link 未加载成功");
  window.Plaid.create({
    token,
    onSuccess: (publicToken, metadata) => onSuccess(publicToken, metadata.institution),
    onExit,
  }).open();
}
