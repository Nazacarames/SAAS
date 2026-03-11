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
}

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
  inboundLatencySamples: 0
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

export const getMessageStats = () => ({
  ...stats,
  inboundLatencyMsAvg: Number(stats.inboundLatencyMsAvg.toFixed(2))
});
