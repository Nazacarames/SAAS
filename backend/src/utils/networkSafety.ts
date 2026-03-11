import dns from "dns/promises";

const isPrivateIp = (ip: string) => {
  const v = String(ip || "").trim();
  return v.startsWith("10.") || v.startsWith("127.") || v.startsWith("192.168.") || v.startsWith("169.254.") || /^172\.(1[6-9]|2\d|3[0-1])\./.test(v) || v === "::1";
};

export const assertSafeWebhookUrl = async (urlRaw: string) => {
  const u = new URL(String(urlRaw || ""));
  if (u.protocol !== "https:") throw new Error("webhook_url_requires_https");
  const host = u.hostname;
  const records = await dns.lookup(host, { all: true });
  if ((records || []).some((r: any) => isPrivateIp(r.address))) throw new Error("webhook_url_private_ip_blocked");
  return u.toString();
};
