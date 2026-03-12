interface MessageStats {
  inboundTotal: number;
  inboundFromMeTotal: number;
  inboundExternalTotal: number;
  duplicatesTotal: number;
  processedErrorsTotal: number;
  lastInboundAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  inboundLatencyMsAvg: number;
  inboundLatencySamples: number;
  outboundAttemptedTotal: number;
  outboundSentTotal: number;
  outboundDuplicateTotal: number;
  outboundRejectedTotal: number;
  lastOutboundAt: string | null;
  lastOutboundReason: string | null;
}

export interface MessageAlert {
  key: string;
  severity: "warn" | "critical";
  value: number;
  threshold: number;
  detail: string;
}

const clampThreshold = (value: number, fallback: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
};

const resolveDuplicateWarnPercent = () =>
  clampThreshold(Number(process.env.WA_OUTBOUND_DUPLICATE_WARN_PERCENT || 40), 40, 1, 100);

const resolveRejectWarnPercent = () =>
  clampThreshold(Number(process.env.WA_OUTBOUND_REJECT_WARN_PERCENT || 15), 15, 1, 100);

const resolveErrorWarnCount = () =>
  clampThreshold(Number(process.env.WA_INBOUND_ERROR_WARN_COUNT || 10), 10, 1, 10000);

const stats: MessageStats = {
  inboundTotal: 0,
  inboundFromMeTotal: 0,
  inboundExternalTotal: 0,
  duplicatesTotal: 0,
  processedErrorsTotal: 0,
  lastInboundAt: null,
  lastErrorAt: null,
  lastErrorMessage: null,
  inboundLatencyMsAvg: 0,
  inboundLatencySamples: 0,
  outboundAttemptedTotal: 0,
  outboundSentTotal: 0,
  outboundDuplicateTotal: 0,
  outboundRejectedTotal: 0,
  lastOutboundAt: null,
  lastOutboundReason: null
};

export const recordInboundMessage = (opts: { fromMe: boolean; createdAt: Date }) => {
  stats.inboundTotal += 1;
  if (opts.fromMe) stats.inboundFromMeTotal += 1;
  else stats.inboundExternalTotal += 1;

  stats.lastInboundAt = new Date().toISOString();

  const latencyMs = Math.max(0, Date.now() - opts.createdAt.getTime());
  stats.inboundLatencySamples += 1;
  stats.inboundLatencyMsAvg =
    (stats.inboundLatencyMsAvg * (stats.inboundLatencySamples - 1) + latencyMs) /
    stats.inboundLatencySamples;
};

export const recordInboundDuplicate = () => {
  stats.duplicatesTotal += 1;
};

export const recordInboundError = (error: unknown) => {
  stats.processedErrorsTotal += 1;
  stats.lastErrorAt = new Date().toISOString();
  stats.lastErrorMessage =
    error instanceof Error ? error.message : typeof error === "string" ? error : "unknown_error";
};

export const recordOutboundAttempt = () => {
  stats.outboundAttemptedTotal += 1;
  stats.lastOutboundAt = new Date().toISOString();
  stats.lastOutboundReason = "attempt";
};

export const recordOutboundSent = () => {
  stats.outboundSentTotal += 1;
  stats.lastOutboundAt = new Date().toISOString();
  stats.lastOutboundReason = "sent";
};

export const recordOutboundDuplicate = (reason = "duplicate") => {
  stats.outboundDuplicateTotal += 1;
  stats.lastOutboundAt = new Date().toISOString();
  stats.lastOutboundReason = reason;
};

export const recordOutboundRejected = (reason = "rejected") => {
  stats.outboundRejectedTotal += 1;
  stats.lastOutboundAt = new Date().toISOString();
  stats.lastOutboundReason = reason;
};

export const getMessageStats = () => ({
  ...stats,
  inboundLatencyMsAvg: Number(stats.inboundLatencyMsAvg.toFixed(2))
});

export const getMessageAlerts = (): MessageAlert[] => {
  const alerts: MessageAlert[] = [];

  const attempted = Math.max(0, stats.outboundAttemptedTotal);
  if (attempted > 0) {
    const duplicatePercent = (stats.outboundDuplicateTotal / attempted) * 100;
    const duplicateWarn = resolveDuplicateWarnPercent();
    if (duplicatePercent >= duplicateWarn) {
      alerts.push({
        key: "outbound_duplicate_rate",
        severity: duplicatePercent >= Math.min(95, duplicateWarn + 20) ? "critical" : "warn",
        value: Number(duplicatePercent.toFixed(2)),
        threshold: duplicateWarn,
        detail: "High outbound duplicate rate detected in current process counters"
      });
    }

    const rejectedPercent = (stats.outboundRejectedTotal / attempted) * 100;
    const rejectWarn = resolveRejectWarnPercent();
    if (rejectedPercent >= rejectWarn) {
      alerts.push({
        key: "outbound_rejected_rate",
        severity: rejectedPercent >= Math.min(95, rejectWarn + 20) ? "critical" : "warn",
        value: Number(rejectedPercent.toFixed(2)),
        threshold: rejectWarn,
        detail: "Outbound payload/idempotency rejections exceed baseline"
      });
    }
  }

  const inboundErrorWarn = resolveErrorWarnCount();
  if (stats.processedErrorsTotal >= inboundErrorWarn) {
    alerts.push({
      key: "inbound_error_volume",
      severity: stats.processedErrorsTotal >= inboundErrorWarn * 2 ? "critical" : "warn",
      value: stats.processedErrorsTotal,
      threshold: inboundErrorWarn,
      detail: "Inbound processing errors crossed warning threshold"
    });
  }

  return alerts;
};
