/**
 * Shared render-side types. Architect-owned.
 */
import type * as THREE from 'three';
import type { Season } from '../core/types';
import type { Game } from '../sim/game';

/** Per-frame context passed to every sub-renderer's update(). */
export interface FrameContext {
  game: Game;
  camera: THREE.PerspectiveCamera;
  /** Real seconds since the renderer started (for animations that run even when paused, e.g. water). */
  realTime: number;
  realDt: number;
  /** Game seconds simulated this frame (0 when paused) — use for gameplay-synced animations (walk cycles). */
  gameDt: number;
  /** 0 = night, 1 = full day. */
  daylight: number;
  /** Ground snow cover 0..1. */
  snow: number;
  season: Season;
  /** 0..1 progress through the year (for smooth seasonal colour blends). */
  yearProgress: number;
  /** Camera focus point on the ground (world coords) and camera distance (for LOD / culling). */
  focusX: number;
  focusZ: number;
  cameraDistance: number;
  quality: 'low' | 'medium' | 'high';
}

/** Common sub-renderer interface. */
export interface SubRenderer {
  /** Called when a new game is started/loaded: drop all state and rebuild from the new game. */
  setGame(game: Game): void;
  update(ctx: FrameContext): void;
  dispose(): void;
}

/** World-space emitter anchor published by BuildingRenderer for EffectsRenderer. */
export interface EmitterAnchor {
  x: number;
  y: number;
  z: number;
  /** 0..1 */
  strength: number;
  /** Building id the anchor belongs to. */
  buildingId: number;
}

export type PickResult = { kind: 'citizen'; id: number } | { kind: 'building'; id: number } | null;
