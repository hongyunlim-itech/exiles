/**
 * WebGLRenderer construction & quality presets shared by GameRenderer and the dev sandbox. OWNER: render-scene.
 */
import * as THREE from 'three';
import { pixelRatioForTier } from './perf';

export type Quality = 'low' | 'medium' | 'high';

export function createWebGLRenderer(opts: { antialias?: boolean } = {}): THREE.WebGLRenderer {
  const r = new THREE.WebGLRenderer({
    antialias: opts.antialias ?? true,
    powerPreference: 'high-performance',
    stencil: false,
    preserveDrawingBuffer: false,
  });
  r.outputColorSpace = THREE.SRGBColorSpace;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.05;
  r.shadowMap.enabled = true;
  // PCFSoftShadowMap was folded into PCFShadowMap (soft Vogel-disk filtering, uses shadow.radius) in r18x.
  r.shadowMap.type = THREE.PCFShadowMap;
  r.domElement.style.display = 'block';
  r.domElement.style.touchAction = 'none';
  r.domElement.tabIndex = 0;
  return r;
}

/** Pixel ratio for a quality tier on this device (high min(dpr, 1.5), medium 1, low 0.75). */
export function pixelRatioFor(quality: Quality): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  return pixelRatioForTier(quality, dpr);
}

/** Unmasked renderer string of a WebGL context ('' if unavailable). */
export function glRendererName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return typeof name === 'string' ? name : '';
  } catch {
    return '';
  }
}

/**
 * GPU renderer string from a throw-away WebGL context (used before the real renderer exists, e.g. to decide on
 * MSAA, which is fixed at context creation). '' when WebGL or the debug extension is unavailable.
 */
export function detectGpuRenderer(): string {
  if (typeof document === 'undefined') return '';
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return '';
    const name = glRendererName(gl);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return '';
  }
}
