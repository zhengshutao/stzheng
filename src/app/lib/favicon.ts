import { useEffect } from "react";

// 股票页面的标签页图标:深底 + 两根 K 线 + 折线,颜色可按涨跌切换(红涨绿跌)
export function stockFaviconHref(color = "#3b82f6"): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="7" fill="#060a14"/>
<line x1="10" y1="7" x2="10" y2="25" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
<rect x="7" y="11" width="6" height="9" rx="1" fill="${color}"/>
<line x1="22" y1="5" x2="22" y2="21" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
<rect x="19" y="8" width="6" height="8" rx="1" fill="${color}"/>
<polyline points="4,27 12,22 18,24 28,13" fill="none" stroke="#e5e7eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// 挂载期间替换 <link rel="icon">,卸载时还原
export function useFavicon(href: string) {
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    const prevHref = link.href;
    const prevType = link.type;
    link.type = "image/svg+xml";
    link.href = href;
    return () => {
      link.type = prevType;
      link.href = prevHref;
    };
  }, [href]);
}
