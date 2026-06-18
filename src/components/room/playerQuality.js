const QUALITY_BANDWIDTH_MBPS = {
  playerQuality480p: 1.2,
  playerQuality720p: 2.5,
  playerQuality1080p: 4.5,
};

export function estimateAvailableBandwidthMbps() {
  if (typeof navigator === 'undefined') return 8;
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const downlink = Number(connection?.downlink || 0);
  const effectiveType = String(connection?.effectiveType || '').toLowerCase();
  if (Number.isFinite(downlink) && downlink > 0) {
    return effectiveType === '4g' ? Math.max(downlink, 8) : downlink;
  }

  if (effectiveType === 'slow-2g') return 0.25;
  if (effectiveType === '2g') return 0.6;
  if (effectiveType === '3g') return 1.8;
  if (effectiveType === '4g') return 8;
  return 8;
}

function estimateOriginalBandwidthMbps(item) {
  const sizeBytes = Number(item?.originalSizeBytes || 0);
  const durationSec = Number(item?.durationSec || item?.duration || 0);
  if (sizeBytes > 0 && durationSec > 0) {
    return (sizeBytes * 8) / durationSec / 1_000_000;
  }

  const height = Number(item?.sourceHeight || item?.height || 0);
  if (height >= 2160) return 24;
  if (height >= 1440) return 14;
  if (height >= 1080) return 8;
  if (height >= 720) return 4.2;
  return 2.4;
}

function estimateRenditionBandwidthMbps(rendition, fallbackKey) {
  const sizeBytes = Number(rendition?.sizeBytes || 0);
  const durationSec = Number(rendition?.durationSec || 0);
  if (sizeBytes > 0 && durationSec > 0) {
    return (sizeBytes * 8) / durationSec / 1_000_000;
  }
  return QUALITY_BANDWIDTH_MBPS[fallbackKey] || 3.2;
}

export function chooseAutoPlaybackSource(item, sources) {
  const availableMbps = estimateAvailableBandwidthMbps();
  const durationSec = Number(item?.durationSec || 0);
  const renditionByHeight = new Map(
    (Array.isArray(item?.renditions) ? item.renditions : [])
      .map((rendition) => [Number(rendition.height || 0), rendition]),
  );
  const candidates = [];

  [
    [480, 'playerQuality480p'],
    [720, 'playerQuality720p'],
    [1080, 'playerQuality1080p'],
  ].forEach(([height, key]) => {
    if (!sources?.[key]) return;
    const rendition = renditionByHeight.get(height) || {};
    candidates.push({
      key,
      source: sources[key],
      rank: height,
      requiredMbps: estimateRenditionBandwidthMbps({ ...rendition, durationSec }, key) * 1.05,
    });
  });

  if (sources?.playerQualityOriginal) {
    const sourceHeight = Number(item?.sourceHeight || item?.height || 0);
    candidates.push({
      key: 'playerQualityOriginal',
      source: sources.playerQualityOriginal,
      rank: sourceHeight > 0 ? sourceHeight : 2000,
      requiredMbps: estimateOriginalBandwidthMbps(item) * 1.1,
    });
  }

  const ranked = candidates
    .filter((candidate) => candidate.source)
    .sort((a, b) => b.rank - a.rank);
  const bestSmooth = ranked.find((candidate) => candidate.requiredMbps <= availableMbps);
  if (bestSmooth) return { key: 'playerQualityAuto', source: bestSmooth.source, resolvedQualityKey: bestSmooth.key };
  const lowestReady = ranked[ranked.length - 1];
  if (lowestReady) return { key: 'playerQualityAuto', source: lowestReady.source, resolvedQualityKey: lowestReady.key };
  if (sources?.playerQualityAuto) return { key: 'playerQualityAuto', source: sources.playerQualityAuto, resolvedQualityKey: 'playerQualityAuto' };
  return { key: 'playerQualityAuto', source: '' };
}

export function pickInitialPlaybackSource(item, sources) {
  const autoSource = chooseAutoPlaybackSource(item, sources);
  if (autoSource.source) return autoSource;
  const firstEntry = Object.entries(sources || {}).find(([, source]) => Boolean(source));
  return {
    key: firstEntry?.[0] || 'playerQualityAuto',
    source: firstEntry?.[1] || '',
    resolvedQualityKey: firstEntry?.[0] || 'playerQualityAuto',
  };
}
