export const FRIEND_SKINS = [
  { id: 'classic', label: 'Classic — waving friend' },
  { id: 'conquest', label: 'Conquest — slow-motion arrival' },
];
export const normaliseFriendSkin = value => FRIEND_SKINS.some(skin => skin.id === value) ? value : 'classic';

const ease = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };

/** A deterministic 15-second entrance, sampled identically on play and seek. */
export function conquestArrival(time) {
  const t = Number.isFinite(time) ? Math.max(0, time) : 0;
  return {
    zoom: t < 3 ? 1 : t < 5 ? 1 + 2 * ease((t - 3) / 2) : t < 11 ? 3 : 3 - 2 * ease(t - 11),
    sprite: t >= 5,
    altitude: 24 * (1 - ease((t - 5) / 5)),
    opacity: ease((t - 5) / .6),
    focus: ease((t - 5) / .75) * (1 - ease(t - 11)),
  };
}
