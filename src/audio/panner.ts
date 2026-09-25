// Reproduces the Web Audio PannerNode that BetterCrewLink creates per peer:
//   panningModel 'equalpower', distanceModel 'linear', refDistance 0.1, rolloffFactor 1,
//   source position (x, y, -0.5), listener at the origin facing -Z with +Y up.
// Formulas follow the Web Audio API spec sections "Azimuth and Elevation",
// "Equal-power panning" (mono input) and "Linear distance model".

export const PANNER_REF_DISTANCE = 0.1;
export const PANNER_Z = -0.5;

export type StereoGain = { left: number; right: number };

/** Linear distance gain for a source at `distance` with the given maxDistance. */
export function linearDistanceGain(distance: number, maxDistance: number): number {
  const ref = PANNER_REF_DISTANCE;
  if (maxDistance <= ref) return 1;
  const clamped = Math.max(Math.min(distance, maxDistance), ref);
  return 1 - (clamped - ref) / (maxDistance - ref);
}

/** Equal-power left/right gains for the source azimuth (elevation is ignored by the spec). */
export function equalPowerPan(x: number, z: number = PANNER_Z): StereoGain {
  // Project onto the listener's horizontal plane (drop the up axis) and normalise.
  const length = Math.hypot(x, z);
  let azimuth = 0;
  if (length > 0) {
    const cosToRight = Math.max(-1, Math.min(1, x / length));
    azimuth = (Math.acos(cosToRight) * 180) / Math.PI;
    const frontBack = -z / length; // dot with forward (0, 0, -1)
    if (frontBack < 0) azimuth = 360 - azimuth;
    azimuth = azimuth >= 0 && azimuth <= 270 ? 90 - azimuth : 450 - azimuth;
  }
  // Mono equal-power panning.
  if (azimuth < -90) azimuth = -180 - azimuth;
  else if (azimuth > 90) azimuth = 180 - azimuth;
  const position = (azimuth + 90) / 180;
  return { left: Math.cos((position * Math.PI) / 2), right: Math.sin((position * Math.PI) / 2) };
}

/** Combined per-channel gain of BCL's panner for a pan position (dx, dy) in game units. */
export function pannerGains(panPosition: [number, number], maxDistance: number): StereoGain {
  const [x, y] = panPosition;
  const distance = Math.sqrt(x * x + y * y + PANNER_Z * PANNER_Z);
  const attenuation = linearDistanceGain(distance, maxDistance);
  const pan = equalPowerPan(x);
  return { left: pan.left * attenuation, right: pan.right * attenuation };
}
