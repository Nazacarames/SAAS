export const digitsOnly = (raw: string): string => String(raw || "").replace(/\D/g, "");

// Normalize AR numbers so 54XXXXXXXXXX and 549XXXXXXXXXX converge to same WhatsApp-style number.
export const normalizeWaPhone = (raw: string): string => {
  const d = digitsOnly(raw);
  if (!d) return "";
  if (d.startsWith("54") && d.length >= 12 && d[2] !== "9") return `549${d.slice(2)}`;
  return d;
};

export const last10Digits = (raw: string): string => {
  const d = digitsOnly(raw);
  return d.slice(-10);
};
