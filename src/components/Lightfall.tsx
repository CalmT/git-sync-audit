import { useEffect, useRef } from 'react';
import { Mesh, Program, Renderer, Triangle } from 'ogl';
import './Lightfall.css';

type LightfallProps = {
  className?: string;
  colors?: string[];
  backgroundColor?: string;
  speed?: number;
  streakCount?: number;
  streakWidth?: number;
  streakLength?: number;
  glow?: number;
  density?: number;
  twinkle?: number;
  zoom?: number;
  backgroundGlow?: number;
  opacity?: number;
  paused?: boolean;
  dpr?: number;
};

const MAX_COLORS = 8;

const hexToRGB = (hex: string) => {
  const value = hex.replace('#', '').padEnd(6, '0');
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
};

const prepColors = (input: string[]) => {
  const base = (input.length ? input : ['#8BC6A5', '#D7C58A', '#9FBEB0']).slice(0, MAX_COLORS);
  const colors = Array.from({ length: MAX_COLORS }, (_, index) => hexToRGB(base[Math.min(index, base.length - 1)]));
  return { colors, count: base.length };
};

const vertex = `
attribute vec2 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const fragment = `
precision highp float;
uniform vec3 iResolution;
uniform float iTime;
uniform vec3 uColor0;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
uniform vec3 uColor4;
uniform vec3 uColor5;
uniform vec3 uColor6;
uniform vec3 uColor7;
uniform int uColorCount;
uniform vec3 uBgColor;
uniform float uSpeed;
uniform int uStreakCount;
uniform float uStreakWidth;
uniform float uStreakLength;
uniform float uGlow;
uniform float uDensity;
uniform float uTwinkle;
uniform float uZoom;
uniform float uBgGlow;
uniform float uOpacity;
varying vec2 vUv;

vec3 palette(float h) {
  int count = uColorCount;
  if (count < 1) count = 1;
  int idx = int(floor(clamp(h, 0.0, 0.999999) * float(count)));
  if (idx <= 0) return uColor0;
  if (idx == 1) return uColor1;
  if (idx == 2) return uColor2;
  if (idx == 3) return uColor3;
  if (idx == 4) return uColor4;
  if (idx == 5) return uColor5;
  if (idx == 6) return uColor6;
  return uColor7;
}

vec3 tanhv(vec3 x) {
  vec3 e = exp(-2.0 * x);
  return (1.0 - e) / (1.0 + e);
}

vec2 sceneC(vec2 frag, vec2 resolution) {
  vec2 point = (frag + frag - resolution) / resolution.x;
  float z = 0.0;
  float distance = 1e3;
  vec4 ray = vec4(0.0);
  for (int k = 0; k < 39; k++) {
    if (distance <= 1e-4) break;
    ray = z * normalize(vec4(point, uZoom, 0.0)) - vec4(0.0, 4.0, 1.0, 0.0) / 4.5;
    distance = 1.0 - sqrt(length(ray * ray));
    z += distance;
  }
  return vec2(ray.x, atan(ray.z, ray.y));
}

void mainImage(out vec4 outputColor, vec2 coordinate) {
  vec2 resolution = iResolution.xy;
  vec2 uv = (coordinate + coordinate - resolution) / resolution.x;
  float time = 0.1 * iTime * uSpeed + 9.0;
  float rings = max(1.0, floor(6.28318530718 * max(uDensity, 0.05) + 0.5));
  vec2 grid = vec2(5e-3, 6.28318530718 / rings);
  vec2 center = sceneC(coordinate, resolution);
  vec2 dx = sceneC(coordinate + vec2(1.0, 0.0), resolution) - center;
  vec2 dy = sceneC(coordinate + vec2(0.0, 1.0), resolution) - center;
  dx.y -= 6.28318530718 * floor(dx.y / 6.28318530718 + 0.5);
  dy.y -= 6.28318530718 * floor(dy.y / 6.28318530718 + 0.5);
  vec2 feather = abs(dx) + abs(dy);
  vec2 point = vec2(2.0, 1.0) * uv - (resolution / resolution.x) * vec2(0.0, 1.0);
  vec4 light = vec4(uBgColor * 90.0 * uBgGlow / (1e3 * dot(point, point) + 6.0), 0.0);
  float width = 5e-4 * uStreakWidth;
  vec2 antiAlias = vec2(max(length(feather), 1e-5));
  float tail = 19.0 / max(uStreakLength, 0.05);

  for (int index = 0; index < 16; index++) {
    if (index >= uStreakCount) break;
    float layer = float(index) + 1.0;
    float randomValue = fract(sin(dot(vec2(layer, floor(center.x / grid.x + 0.5)), vec2(7.0, 11.0)) * 73.0));
    vec2 particle = center - (time + time * randomValue) * vec2(0.0, 1.0);
    particle -= floor(particle / grid + 0.5) * grid;
    float hue = fract(8663.0 * randomValue);
    float flicker = mix(1.5, 1.0 + sin(time + 7.0 * hue + 4.0), uTwinkle);
    vec2 inner = vec2(length(max(particle, vec2(-1.0, 0.0))), length(particle) - width) - width;
    vec2 smoothMask = vec2(1.0) - smoothstep(-antiAlias, antiAlias, inner);
    light.rgb += dot(smoothMask, vec2(exp(tail * particle.y), 3.0)) * palette(hue) * flicker;
    center.x += grid.x / 8.0;
  }

  vec3 color = sqrt(tanhv(max(light.rgb * uGlow - vec3(0.04, 0.08, 0.02), 0.0)));
  float peak = max(color.r, max(color.g, color.b));
  float alpha = smoothstep(0.08, 0.72, peak) * uOpacity;
  vec3 chroma = clamp(color / max(peak, 1e-4), 0.0, 1.0);
  chroma = pow(chroma, vec3(1.18));
  outputColor = vec4(chroma, alpha);
}

void main() {
  vec4 color;
  mainImage(color, vUv * iResolution.xy);
  gl_FragColor = color;
}`;

export default function Lightfall({
  className = '',
  colors = ['#8BC6A5', '#D7C58A', '#9FBEB0'],
  backgroundColor = '#EAF3EC',
  speed = 0.2,
  streakCount = 4,
  streakWidth = 0.75,
  streakLength = 1.25,
  glow = 0.65,
  density = 0.4,
  twinkle = 0.6,
  zoom = 3.4,
  backgroundGlow = 0.32,
  opacity = 0.4,
  paused = false,
  dpr,
}: LightfallProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const renderer = new Renderer({ dpr: Math.min(dpr ?? window.devicePixelRatio ?? 1, 2.5), alpha: true, antialias: true });
    const gl = renderer.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    container.appendChild(canvas);
    const prepared = prepColors(colors);
    const uniforms: Record<string, { value: unknown }> = {
      iResolution: { value: [gl.drawingBufferWidth, gl.drawingBufferHeight, 1] },
      iTime: { value: 0 },
      uColorCount: { value: prepared.count },
      uBgColor: { value: hexToRGB(backgroundColor) },
      uSpeed: { value: speed },
      uStreakCount: { value: Math.max(1, Math.min(16, Math.round(streakCount))) },
      uStreakWidth: { value: streakWidth },
      uStreakLength: { value: streakLength },
      uGlow: { value: glow },
      uDensity: { value: density },
      uTwinkle: { value: twinkle },
      uZoom: { value: zoom },
      uBgGlow: { value: backgroundGlow },
      uOpacity: { value: opacity },
    };
    prepared.colors.forEach((color, index) => { uniforms[`uColor${index}`] = { value: color }; });
    const program = new Program(gl, { vertex, fragment, uniforms });
    const geometry = new Triangle(gl);
    const mesh = new Mesh(gl, { geometry, program });
    const resize = () => {
      const bounds = container.getBoundingClientRect();
      renderer.setSize(bounds.width, bounds.height);
      uniforms.iResolution.value = [gl.drawingBufferWidth, gl.drawingBufferHeight, 1];
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    let animationFrame = 0;
    const animate = (time: number) => {
      animationFrame = requestAnimationFrame(animate);
      if (!paused) {
        uniforms.iTime.value = time * 0.001;
        renderer.render({ scene: mesh });
      }
    };
    animationFrame = requestAnimationFrame(animate);
    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      canvas.remove();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [backgroundColor, backgroundGlow, colors, density, dpr, glow, opacity, paused, speed, streakCount, streakLength, streakWidth, twinkle, zoom]);

  return <div ref={containerRef} className={`lightfall-container ${className}`} aria-hidden="true" />;
}
